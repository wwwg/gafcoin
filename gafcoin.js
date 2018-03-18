// constants (may make configurable later)
const P2P_PORT = 9284,
    P2P_TEST_PORT = 9285, // to run 2 nodes on one computer
    BLOCK_SIZE = 10; // number of transactions that make a block

// imports
const crypto = require('crypto'),
    net = require('net'),
    uws = require("uws"),
    createKeccakHash = require("keccak"),
    uuidv4 = require('uuid/v4'),
    EventEmitter = require('events'),
    EC = require('elliptic').ec;
let ec = new EC('secp256k1')
// make crypto easier
const keccak = str => {
    let hash = createKeccakHash('keccak256');
    hash.update(str);
    return hash.digest('hex');
}, genECKeypair = () => {
    let key = ec.genKeyPair();
    return {
        pub: key.getPublic().encode('hex'),
        priv: key.getPrivate('hex')
    }
}, ECSign = (privKey, msg) => {
    let key = ec.keyFromPrivate(privKey, 'hex');
    return key.sign(msg).toDER('hex');
}, ECVerify = (pubKey, msg, signature) => {
    let key = ec.keyFromPublic(pubKey, 'hex');
    return key.verify(msg, signature);
}

// net
class NetNode extends EventEmitter {
    log(...args) {
        args.unshift((this.name || 'very sad node without a name'));
        args[0] += ' : ';
        console.log.apply(console, args);
    }
    connectPeer(address) {
        // create an outgoing websocket connection to address
        let ws = new uws(address),
            me = this;
        ws.on('open', () => {
            // make life a little easier
            ws.ip = ws._socket.remoteAddress;
            ws.port = ws._socket.remotePort;
            ws.family = ws._socket.remoteFamily;
            // this.log(`new outbound peer '${ws.ip}:${ws.port}'`);
            me.emit('newPeer', ws);
        }).on('close', () => {
            me.handleClose(ws);
        }).on('message', msg => {
            me.recv(ws, msg);
        }).on('error', err => {
            console.log('WARN: got an outbound peer socket error:');
            console.log(err);
        });
        this.outPeers.push(ws);
        ws.peerType = 'out';
        ws.id = uuidv4();
    }
    constructor(listenPort) {
        super();
        this._port = listenPort;
        this.outPeers = []; // sockets we connect to
        this.inPeers = []; // sockets that connect to us
        this.server = new uws.Server({
            port: listenPort
        });
        let s = this.server,
            me = this;
        s.on('connection', ws => {
            // make life a little easier
            ws.ip = ws._socket.remoteAddress;
            ws.port = ws._socket.remotePort;
            ws.family = ws._socket.remoteFamily;
            
            // this.log(`new inbound peer '${ws.ip}:${ws.port}'`);
            this.inPeers.push(ws);
            ws.id = uuidv4();
            ws.peerType = 'in';
            me.emit('newPeer', ws);
            ws.on('message', msg => {
                me.recv(ws, msg);
            }).on('close', () => {
                me.handleClose(ws);
            });
        });
    }
    // outbound data
    send(peer, op, data) {
        if (typeof data !== 'object') {
            throw new Error('can only send json to peers');
        }
        let packet = JSON.stringify({
            op: op,
            data: data
        });
        try {
            peer.send(packet);
        } catch (e) {
            console.log('WARN : failed to send packet to peer');
        }
    }
    broadcast(op, data) {
        let totalPeers = this.outPeers.concat(this.inPeers);
        for (let i = 0; i < totalPeers.length; ++i) {
            this.send(totalPeers[i], op, data);
        }
    }
    announceBlock(block) {
        let blk = block.serialize();
        this.broadcast('newblk', blk);
    }
    announceTx(tx) {
        let tx = tx.serialize();
        this.broadcast('tx', tx);
    }
    // inbound data
    recv(peer, msg) {
        // validate incoming data
        let obj,
            me = this;
        try {
            obj = JSON.parse(msg);
        } catch(e) {
            console.log('WARN : failed to parse inbound data:');
            console.log(e);
            return;
        }
        if (!obj.op || !obj.data) {
            console.log('WARN : recieved malformed packet');
            return;
        }
        let op = obj.op,
            data = obj.data;
        // handle data accordingly
        switch (op) {
            case 'getaddr':
                // Get all connected peers and send to client
                let peerList = [];
                let totalPeers = this.outPeers.concat(this.inPeers);
                for (let i = 0; i < totalPeers.length; ++i) {
                    const strPeer = totalPeers[i].ip + ':' + totalPeers[i].port;
                    if (!peerList.includes(strPeer)) {
                        peerList.push(strPeer);
                    }
                }
                me.send(peer, 'gotaddr', peerList);
                break;
            case 'gotaddr':
                // handle getaddr response
                // connect to all peers in the list. todo MAKE THIS BETTER OR SOMETHING
                if (data instanceof Array) {
                    for (let i = 0; i < data.length; ++i) {
                        let addr = 'ws://' + data[i];
                        me.connectPeer(addr);
                    }
                } else {
                    console.log('got bad getaddr response');
                }
                break;
            case 'newblk':
                let blk = Block.from(data);
                me.emit('block', blk);
                break;
            default:
                console.warn('Recieved unknown protocol operation "' + obj.op + '"');
                break;
        }
    }
    // force close peer
    shutdown(peer) {
        peer.close();
    }
    // handle peer close
    handleClose(peer) {
        // remove peer from it's respective array
        let found = false;
        let key = peer.peerType + 'Peers';
        for (let i = 0; i < this[key].length; ++i) {
            if (this[key][i].id === peer.id) {
                this[key].splice(i, 1);
                found = true;
                break;
            }
        }
        if (found) {
            this.emit('lostPeer', peer);
        } else {
            console.log('WARN : could not identify peer to close');
        }
    }
}
// wallet
class Wallet {
    constructor(privateKey) {
        this.address = null; // Public key
        this.private = null; // Private key
        if (!privateKey) {
            // A new wallet has to be generated
            let pair = genECKeypair();
            this.address = pair.pub;
            this.private = pair.priv;
        } else {
            let key;
            try {
                key = ec.keyFromPrivate(privateKey);
            } catch (e) {
                console.log('Invalid wallet private key:');
                console.log(e);
                return;
            }
            this.private = privateKey;
            key = ec.keyFromPrivate(privateKey, 'hex');
            // Get address from private key
            this.address = key.getPublic().encode('hex');
        }
    }
}
// components of a blockchain
class Transaction {
    static from(txData) {
        return new Transaction(txData.i, txData.o, txData.value, txData.sig);
    }
    constructor(sourceAddr, destAddr, value, signature) {
        this.source = sourceAddr;
        this.dest = destAddr;
        this.value = value;
        this.hash = this.calcHash();
        if (signature) {
            this.sig = signature;
            this.signed = true;
        } else {
            this.sig = null;
            this.signed = false;
        }
    }
    calcHash() {
        return keccak(this.source + this.dest + this.value);
    }
    validate() {
        if (!this.sig) throw new Error("Unable to validate unsigned transaction");
        // Source address is the public key
        return ECVerify(this.source, this.hash, this.sig);
    }
    serialize() {
        return {
            'i': this.source,
            'o': this.dest,
            'value': this.value,
            'hash': this.hash,
            'sig': this.sig
        }
    }
    sign(privKey) {
        if (this.signed) throw new Error("Transaction is already signed");
        // Sign with wallet private key
        try {
            this.sig = ECSign(privKey, this.hash);
            this.signed = true;
        } catch(e) {
            console.log('WARN : failed to sign transaction:');
            console.log(e);
        }
    }
}
class Block {
    static from(data) {
        let txs = [];
        for (let i = 0; i < data.txs.length; ++i) {
            let tx = Transaction.from(data.txs[i]);
            txs.push(tx);
        }
        return new Block(data.ts, data.last, txs, data.pos, data.nonce, data.hash);
    }
    constructor(time, lastHash, transactions, pos, nonce, extHash) {
        this.pos = pos; // position on the chain
        this.time = time;
        this.lastHash = lastHash;
        if (nonce) {
            this.nonce = nonce;
        } else {
            this.nonce = 0;
        }
        this.transactions = transactions;
        if (extHash) {
            this.hash = extHash;
        } else {
            this.hash = this.calcHash();
        }
    }
    calcHash() {
        let body = JSON.stringify(this.transactions);
        return keccak(this.lastHash + this.time + body + this.nonce);
    }
    mine(diff) { // Mine at difficulty
        let subhash = this.hash.substring(0, diff),
            target = "0".repeat(diff);
        while (subhash !== target) {
            this.nonce++;
            this.hash = this.calcHash();
            subhash = this.hash.substring(0, diff);
        }
    }
    serialize() {
        this.hash = this.calcHash(); // just in case
        let txs = [];
        for (let i = 0; i < this.transactions.length; ++i) {
            let stx = this.transactions[i].serialize();
            txs.push(stx);
        }
        return {
            'pos': this.pos,
            'ts': this.time,
            'last': this.lastHash,
            'nonce': this.nonce,
            'txs': txs,
            'hash': this.hash
        }
    }
}
class BlockChain {
    constructor(originChain) {
        this.chain = (originChain || []);
        this.globalDiff = 1;
        this.blockReward = 10;
        this.pending = [];
    }
    top() {
        if (!this.chain.length) return null;
        return this.chain[this.chain.length - 1];
    }
    at(i) {
        if (!this.chain.length) return null;
        return this.chain[i];
    }
    add(blk) {
        this.chain.push(blk);
    }
    mine(rewardAddr) {
        let b = new Block(Date.now(), this.pending, this.top().hash);
        b.mine(this.globalDiff);
        this.chain.push(b);
        this.pending = [
            new Transaction('GOD', rewardAddr, this.blockReward)
        ];
    }
    addTransaction(transaction) {
        this.pending.push(transaction);
    }
    validate() {
        // todo : validate transactions as well
        if (this.chain.length < 2) return true; // Can't validate a blockchain that small
        for (let i = 1; i < this.chain.length; ++i) {
            let thisBlock = this.chain[i],
                lastBlock = this.chain[i - 1];
            if (thisBlock.hash !== thisBlock.calcHash()) return false;
            if (thisBlock.lastHash !== lastBlock.hash) return false;
        }
        return true;
    }
    validateBlock(blk) {
        if (this.chain.length < 1) return true; // Can't validate genesis block
        if (!blk.transactions.length) {
            // the entire point of a block is that it holds transactions
            return 'empty block';
        }
        if (blk.hash !== blk.calcHash()) {
            // the hash is wrong
            return 'hash mismatch';
        }
        let validBits = '0'.repeat(this.globalDiff),
            hashBits = blk.hash.substring(0, this.globalDiff);
        if (hashBits !== validBits) {
            // block wasnt mined correctly or at all
            return 'not properly mined';
        }
        let validDate = Date.now() + 7200; // 2 hours into the future
        if (blk.time > validDate) {
            // too far into the future
            return 'from the future';
        }
        if (blk.transactions.length > BLOCK_SIZE) {
            // block too big
            return 'too big';
        }
        if (blk.lastHash !== this.top().hash) {
            // this block doesnt go on the top
            return 'wrong last hash';
        }
        // todo : validate transactions in block
        // todo : validate coinbase transaction
        
        return true;
    }
}
class GafNode {
    broadcastNewBlock(blk) {
        if (!blk instanceof Block) throw new Error("broadcastNewBlock only broadcasts blocks");
        this.net.announceBlock(blk);
    }
    constructor(port, privateKey = null) {
        let me = this;
        this.port = port;
        this.net = new NetNode(port);
        this.bc = new BlockChain();
        this.wallet = new Wallet(privateKey);
        this.isMiner = true;
        /*
        if (!privateKey) {
            console.log(`Generated new wallet for node ${port - 9301}:`);
            console.log('Address: "' + this.wallet.address + '"');
            console.log('Private key: "' + this.wallet.private + '"');
        } else {
            console.log(`Using wallet address ${this.wallet.address} for node ${port - 9301}`);
        }
        */
        this.net.on('block', blk => {
            console.log('recieved new block! validating...');
            let valid = me.bc.validateBlock(blk);
            if (valid === true) {
                me.bc.add(blk);
                console.log('block is valid! added to chain.');
            } else {
                console.log('=== INVALID BLOCK ===');
                console.log(' reason: ' + valid);
                console.log(' blockchain height: ' + me.bc.chain.length);
                console.log(' diff: ' + me.bc.globalDiff);
                console.log(' port: ' + me.port);
                console.log('=====================');
            }
        });
    }
}

// create a virtual network for testing stuff
console.log('creating virtual testnet...');
const WALLET_ADDR = '042c94b69058e64ac58ef442919f45415a8f5fcf5e939f69ffba9b80848ed24d75df64305d98ce690d50988e763d83163269aac0162a8e9a35cd46593d594b21fa';
const WALLET_PRIV = 'c594922381eaf44babe7b96906a49acbf913507a0372b55cde4d68622c00aaba';
let network = [];
const NETWORK_SIZE = 6;
let genesisTxs = [];
for (let i = 0; i < BLOCK_SIZE; ++i) {
    let tx = new Transaction('genesis', WALLET_ADDR, 1);
    genesisTxs.push(tx);
}
let genesisBlock = new Block(Date.now(), '', genesisTxs, 0);

for (let i = 0; i < NETWORK_SIZE; ++i) {
    // create nodes for the network
    let node;
    if (i == 0) {
        // master node
        node = new GafNode(9301 + i, WALLET_PRIV);
    } else {
        node = new GafNode(9301 + i);
    }
    node.net.name = 'node' + i;
    network.push(node);
}
let mnode = network[0]; // master node
// connect all the nodes to each other after the network is created
setTimeout(() => {
    console.log('connecting nodes to each other...');
    for (let i = 1; i < NETWORK_SIZE; ++i) {
        let currNode = network[i];
        for (let i2 = 0; i2 < NETWORK_SIZE; ++i2) {
            let currPort = 9301 + i2;
            if (currPort != currNode.port) { // dont connect a node to itself
                currNode.net.connectPeer('ws://127.0.0.1:' + currPort);
            }
        }
    }
}, 50);
setTimeout(() => {
    console.log('propagating genesis block');
    mnode.broadcastNewBlock(genesisBlock);
}, 100);