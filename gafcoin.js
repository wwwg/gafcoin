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
            this.log(`new outbound peer '${ws.ip}:${ws.port}'`);
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
            
            this.log(`new inbound peer '${ws.ip}:${ws.port}'`);
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
                key = ec.keyFromPublic(privateKey);
            } catch (e) {
                console.log('Invalid wallet private key!');
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
    constructor(sourceAddr, destAddr, value) {
        this.source = sourceAddr;
        this.dest = destAddr;
        this.value = value;
        this.hash = this.calcHash();
    }
    calcHash() {
        return keccak(this.source + this.dest + this.value);
    }
}
class Block {
    constructor(time, lastHash, transactions) {
        this.time = time;
        this.lastHash = lastHash;
        this.nonce = 0;
        this.transactions = transactions;
        this.calcHash();
    }
    calcHash() {
        let body = JSON.stringify(this.transactions);
        this.hash = keccak(this.lastHash + this.time + body + this.nonce);
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
        if (this.chain.length < 2) return true; // Can't validate a blockchain that small
        for (let i = 1; i < this.chain.length; ++i) {
            let thisBlock = this.chain[i],
                lastBlock = this.chain[i - 1];
            if (thisBlock.hash !== thisBlock.calcHash()) return false;
            if (thisBlock.lastHash !== lastBlock.hash) return false;
        }
        return true;
    }
}
class GafNode {
    constructor(port, privateKey = null) {
        this.port = port;
        this.net = new NetNode(port);
        this.bc = new BlockChain();
        this.wallet = new Wallet(privateKey);
        if (!privateKey) {
            console.log(`Generated new wallet for node ${port - 9301}:`);
            console.log('Address: "' + this.wallet.address + '"');
            console.log('Private key: "' + this.wallet.private + '"');
        }
    }
}

// create a virtual network for testing stuff
console.log('creating virtual testnet...');
let network = [];
const NETWORK_SIZE = 6;
let genesisBlock = new Block(Date.now(), '', [
    new Transaction('wallet1', 'wallet2', 5),
    new Transaction('wallet1', 'wallet2', 6),
    new Transaction('wallet1', 'wallet2', 7),
    new Transaction('wallet1', 'wallet2', 8),
    new Transaction('wallet1', 'wallet2', 9),
    new Transaction('wallet1', 'wallet2', 10)
]);

for (let i = 0; i < NETWORK_SIZE; ++i) {
    // create nodes for the network
    let node = new GafNode(9301 + i);
    node.net.name = 'node' + i;
    network.push(node);
}
let mnode = network[0]; // master node
// connect all the nodes to each other after the network is created
setTimeout(() => {
    console.log('connecting nodes to each other...');
    for (let i = 0; i < NETWORK_SIZE; ++i) {
        let currNode = network[i];
        for (let i2 = 0; i2 < NETWORK_SIZE; ++i2) {
            let currPort = 9301 + i2;
            if (currPort != currNode.port) { // dont connect a node to itself
                currNode.net.connectPeer('ws://127.0.0.1:' + currPort);
            }
        }
    }
    setTimeout(() => {
        console.log('spawning genesis block with master node..');
        mnode.bc.add(genesisBlock);
    }, 200);
}, 50);