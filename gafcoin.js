// constants (may make configurable later)
const BLOCK_SIZE = 3; // number of transactions that make a block

// imports
const crypto = require('crypto'),
    net = require('net'),
    uws = require("uws"),
    createKeccakHash = require("keccak"),
    uuidv4 = require('uuid/v4'),
    EventEmitter = require('events'),
    fs = require("fs"),
    readline = require("readline"),
    minimist = require("minimist"),
    chalk = require("chalk"),
    EC = require('elliptic').ec;
let ec = new EC('secp256k1');
const rl = readline.createInterface(process.stdin, process.stdout);
// hook console.log to support my cool ass prompt
let _log = console.log.bind(console);
console.log = function() {
    readline.cursorTo(process.stdout, 0);
    _log.apply(console, arguments);
    rl.prompt(true);
}
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
            console.log(chalk.green.bold('new outboud peer "' + ws.ip + ":" + ws.port + '"'));
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
    constructor(listenPort, node) {
        super();
        this.node = node;
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
            
            console.log(chalk.green.bold('new inbound peer "' + ws.ip + ":" + ws.port + '"'));
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
        let stx = tx.serialize();
        this.broadcast('tx', stx);
    }
    reqBlockChain() {
        this.broadcast('getbc', {});
    }
    reqBlock(blockNum) {
        this.broadcast('getblk', {
            n: blockNum
        });
    }
    getPeerPeers(peer) {
        this.send(peer, 'getaddr', {});
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
                    if (totalPeers[i].ip == peer.ip && totalPeers[i].port == peer.port) continue;
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
            case 'tx':
                let tx = Transaction.from(data);
                me.emit('tx', tx);
                break;
            case 'getbc':
                // send our copy of the blockchain
                let sbc;
                try {
                    sbc = me.node.bc.serialize();
                } catch (e) {
                    console.log('Failed to serialize blockchain:');
                    console.log(e);
                }
                me.send(peer, 'gotbc', sbc);
                break;
            case 'gotbc':
                let bc = BlockChain.from(data);
                me.emit('blockchain', bc);
                break;
            case 'getblk':
                if (!data.n) break;
                let requestedBlock = me.node.bc.at(data.n);
                me.send(peer, 'gotblk', requestedBlock.serialize());
                break;
            case 'gotblk':
                let recvBlock = Block.from(data);
                me.emit('recievedBlock', recvBlock);
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
        console.log(chalk.red('lost connection to peer "' + peer.ip + ':' + peer.port));
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
// create genesis block, which is hardcoded into every client
let genesisTxs = [];
for (let i = 0; i < BLOCK_SIZE; ++i) {
    let tx = new Transaction('genesis', '042c94b69058e64ac58ef442919f45415a8f5fcf5e939f69ffba9b80848ed24d75df64305d98ce690d50988e763d83163269aac0162a8e9a35cd46593d594b21fa', 123456789);
    genesisTxs.push(tx);
}
const GENESIS_BLOCK = new Block(1514764800, '', genesisTxs, 0);
delete genesisTxs;

class BlockChain {
    static from(data) {
        let chain = [];
        for (let i = 0; i < data.length; ++i) {
            let blk = Block.from(data[i]);
            chain.push(blk);
        }
        return new BlockChain(chain);
    }
    constructor(originChain) {
        this.chain = (originChain || [GENESIS_BLOCK]);
        if (originChain) {
            this.isExternal = true;
        } else {
            this.isExternal = false;
        }
        this.globalDiff = this.calcDiff();
        this.blockReward = this.calcReward();
    }
    top() {
        if (!this.chain.length) return null;
        return this.chain[this.chain.length - 1];
    }
    at(i) {
        if (!this.chain.length) return null;
        return this.chain[i];
    }
    height() {
        return this.chain.length;
    }
    add(blk) {
        this.chain.push(blk);
    }
    validate() {
        if (this.chain.length < 2) return true; // Can't validate a blockchain that small
        // check the validity of every block in the chain
        for (let i = 1; i < this.chain.length; ++i) {
            let validation = this.validateBlock(this.chain[i]);
            if (validation !== true) {
                return false;
            }
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
        // last hash verification
        let blk2 = this.at(blk.pos - 1);
        if (blk.lastHash !== blk2.hash) {
            // this block doesnt go on the top
            return 'wrong last hash "' + blk.lastHash + '"';
        }
        
        if (blk.transactions[0].source !== 'reward' ||
            blk.transactions[0].value !== this.blockReward) {
            return 'wrong coinbase transaction';
        }
        // transaction validation
        for (let i = 1; i < blk.transactions.length; ++i) {
            let tx = blk.transactions[i];
            if (tx.value <= 0) {
                return 'invalid transaction value';
            }
            // check if the tx signature is valid
            if (!tx.validate()) {
                return 'transaction improperly signed';
            }
            // check if the source has sufficient balance
            let balance = this.balance(tx.source) - tx.value;
            if (balance < 0) {
                return 'transaction withdrawing too much';
            }
        }
        
        return true;
    }
    balance(addr) {
        let total = 0;
        for (const blk of this.chain) {
            for (const tx of blk.transactions) {
                if (tx.source == addr) {
                    total -= tx.value;
                } else if (tx.dest == addr) {
                    total += tx.value;
                }
            }
        }
        return total;
    }
    serialize() {
        let out = [];
        for (let i = 0; i < this.chain.length; ++i) {
            out.push(this.chain[i].serialize());
        }
        return out;
    }
    hash() {
        // hash blockchain for easy comparison
        let khash = createKeccakHash('keccak256');
        for (const blk in this.chain) {
            khash.update(blk.hash);
        }
        return khash.digest('hex');
    }
    equals(bc2) {
        // compare two block chains using their hashes
        return this.hash() === bc2.hash();
    }
    calcDiff() {
        // calculate what the difficulty should be
        // todo
        return 1;
    }
    calcReward() {
        // calculate what the block reward should be
        // todo
        return 10;
    }
}
class GafNode {
    transfer(dest, amount) {
        let me = this,
            tx = new Transaction(me.wallet.address, dest, amount);
        tx.sign(me.wallet.private); // sign tx to verify we made it
        this.net.announceTx(tx); // propagate tx throughout the network
    }
    broadcastNewBlock(blk) {
        if (!blk instanceof Block) throw new Error("broadcastNewBlock only broadcasts blocks");
        this.net.announceBlock(blk);
    }
    sync() {
        // syncronize node with the network
        this.net.reqBlockChain(); // asks every connected peer for their copy of the blockchain
    }
    constructor(port, privateKey = null) {
        let me = this;
        this.port = port;
        this.net = new NetNode(port, this);
        this.bc = new BlockChain();
        this.wallet = new Wallet(privateKey);
        this.isMiner = true;
        this.isSyncronized = false;
        this.pendingTxs = [];
        this.chains = []; // for syncronization
        this.peerCount = 0;
        this.gotFirstPeer = false;
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
            if (blk.pos < me.bc.chain.length) { // this block old and should be ignored
                return;
            }
            let valid = me.bc.validateBlock(blk);
            if (valid === true) {
                me.bc.add(blk);
                console.log(chalk.green.bold(`validated and added block #${me.bc.chain.length}`));
            } else {
                console.log(chalk.red.bold('WARN : Recieved invalid block from peer!'));
                console.log(chalk.red.bold('Reason block is invalid: ') + valid);
                console.log(chalk.red.bold('block number: ') + (me.bc.chain.length + 1));
            }
        }).on('tx', tx => {
            // we dont care about new transactions if we're not a miner
            if (!me.isMiner) return;
            if (!tx.validate()) {
                console.log(chalk.red.bold('WARN : Recieved invalid transaction from peer!'));
                return;
            }
            me.pendingTxs.push(tx);
            if (me.pendingTxs.length === (BLOCK_SIZE - 1)) {
                console.log(chalk.yellow.bold(`found new block ${me.bc.chain.length + 1}, mining...`));
                // create coinbase transaction and add it
                let coinbaseTx = new Transaction('reward', me.wallet.address, me.bc.blockReward);
                me.pendingTxs.unshift(coinbaseTx);
                // create a new block and mine it
                let newBlk = new Block(Date.now(), me.bc.top().calcHash(), me.pendingTxs, me.bc.chain.length);
                newBlk.mine(me.bc.globalDiff);
                console.log(chalk.green.bold(`block ${me.bc.chain.length + 1} mined successfully. resyncronizing in a few seconds..`));
                me.net.announceBlock(newBlk);
                // clear pending transactions
                me.pendingTxs = [];
                setTimeout(() => {
                    me.sync();
                }, 5000);
            }
        }).on('blockchain', bc => {
            if (bc.height() > me.bc.height()) {
                let isChainValid = bc.validate(); // validate the integrity of the chain
                if (isChainValid) {
                    // this blockchain is superior and we need to update ours
                    console.log(chalk.green.bold('Switched to newer valid blockchain recieved from peer'));
                    me.bc = bc;
                } else {
                    console.log(chalk.red.bold('Rejected invalid blockchain from peer.'));
                }
            }
        }).on('newPeer', () => {
            me.peerCount++;
            if (!me.gotFirstPeer) {
                me.gotFirstPeer = true;
                console.log(chalk.green.bold('connected to first peer, syncing with network'));
                me.sync();
            }
        }).on('lostPeer', () => {
            me.peerCount--;
        });
    }
}
process.on('uncaughtException', err => {
    console.error(err);
    process.exit(1);
});
// make the node actually usable
let args = minimist(process.argv.slice(2)),
    pkey = null;
if (args['help'] || !args['p']) {
    console.log('usage:');
    console.log('node gafcoin.js  [ -k <key> ] -p <port>');
    console.log('where <port> is a tcp port to listen on');
    console.log('and <key> is optionally a private key to use for your wallet.');
    process.exit(0);
}
let port = parseInt(args['p']);
if (isNaN(port)) {
    console.error('invalid tcp port');
    process.exit(1);
}
if (args['k']) {
    pkey = args['k'];
}
let handleCmd = msg => {
    let smsg = msg.split(' '),
        cmd = smsg[0];
    switch (cmd) {
        case 'help':
            // todo make this helpful
            console.log('\ncommands:');
            console.log('clear, mine, height, connect, peers');
            break;
        case 'clear':
            console.clear();
            break;
        case 'mine':
            node.isMiner = !node.isMiner;
            console.log(chalk.yellow('mining set to ' + node.isMiner));
            break;
        case 'height':
            console.log(chalk.yellow('current blockchain height: ' + node.bc.chain.length));
            break;
        case 'connect':
        case 'conn':
            let ip = smsg[1];
            if (!ip.startsWith('ws://')) ip = 'ws://' + ip;
            console.log(chalk.yellow('attempting to connect to peer "' + ip + '"'));
            node.net.connectPeer(ip);
            break;
        case 'peers':
            console.log(chalk.yellow('current active peers: ' + (node.net.outPeers.concat(node.net.inPeers)).length));
            break;
        case 'sync':
            console.log(chalk.yellow('starting node syncronization..'));
            node.sync();
            break;
        case 'address':
            console.log(chalk.green(node.wallet.address));
            break;
        case 'private_key':
            console.log(chalk.green(node.wallet.private));
            break;
        case 'balance':
            console.log(chalk.yellow(node.bc.balance(node.wallet.address)));
            break;
        case 'transfer':
            let amount = parseFloat(smsg[1]),
                dest = smsg[2];
            if (node.bc.balance(node.wallet.address) - amount > 0) {
                console.log(chalk.green('trasfering ' + amount + ' to "' + dest + '"'));
                node.transfer(dest, amount);
            } else {
                console.log(chalk.red('you cant afford that'));
            }
            break;
        case 'port':
            console.log('currently listening on tcp port ' + port);
            break;
        case 'eval':
            let expr = msg.split('eval ')[1];
            let res = eval(expr);
            console.log(res);
            break;
        case 'export':
            let epath = smsg[1];
            console.log('writing blockchain to file "' + epath + '"');
            fs.writeFileSync(epath, JSON.stringify(node.bc.serialize()), 'utf8');
            console.log('write complete');
            break;
        case 'import':
            let ipath = smsg[1];
            console.log('reading blockchain from file "' + ipath + '"');
            const bc = fs.readFileSync(ipath, 'utf8');
            node.bc = BlockChain.from(JSON.parse(bc));
            console.log('blockchain imported successfully.');
            break;
        default:
            console.log(chalk.red('invalid command, use "help" for a list'));
            break;
    }
}
let question = () => {
    rl.question(chalk.yellow.bold('gaf> '), msg => {
        handleCmd(msg);
        question();
    });
}
console.log(chalk.white.bold('initializing gafcoin..'));
console.log(chalk.white.bold(`listening on tcp port ${port}`));
if (pkey) {
    console.log(chalk.white.bold(`using private key "${pkey}"`));
} else {
    console.log(chalk.white.bold(`no private key provided, will generate new wallet.`));
}
node = new GafNode(port, pkey);
console.log(chalk.green('successfully opened wallet "' + node.wallet.address + '"'));
question();

module.exports = GafNode;