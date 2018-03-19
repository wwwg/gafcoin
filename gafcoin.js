(() => {
    // network constants (may make configurable later)
    const BLOCK_SIZE = 20, // number of transactions that make a block
        BLOCK_REWARD_HALF_AT = 100, // block reward will half every x blocks
        DIFF_DOUBLE_AT = 200, // network difficulty will double every x blocks
        INIT_NODE = 'ws://198.58.119.239:9284', // original node; hard coded into every node
        PROTOCOL_VERSION = 3; // proto version; versions lower than this are rejected by nodes

    // local constants
    const IS_BROWSER = typeof window !== 'undefined',
        IS_NODEJS = !IS_BROWSER; // im lazy
    // modules for node
    let uws,
        createKeccakHash,
        uuidv4,
        EventEmitter,
        fs,
        readline,
        minimist,
        chalk,
        pako,
        EC;
    if (IS_NODEJS) {
        uws = require("uws");
        createKeccakHash = require("keccak");
        EventEmitter = require('events');
        fs = require("fs");
        readline = require("readline");
        minimist = require("minimist");
        chalk = require("chalk");
        EC = require('elliptic').ec;
        rl = readline.createInterface(process.stdin, process.stdout);
        pako = require('pako');
        // hook console.log to support my cool ass prompt
        let _log = console.log.bind(console);
        console.log = function() {
            readline.cursorTo(process.stdout, 0);
            _log.apply(console, arguments);
            rl.prompt(true);
        }
    }

    // nest entire program inside function for async library loading
    let init = () => {
        // browser-node stuff
        let EE;
        if (IS_BROWSER) EE = window.EventEmitter;
        else EE = EventEmitter;

        let ec;
        if (IS_BROWSER) {
            ec = new window.elliptic.ec('secp256k1');
        } else {
            ec = new EC('secp256k1');
        }
        let uuidv4;
        if (IS_NODEJS) {
            uuidv4 = require('uuid/v4');
        } else {
            uuidv4 = uuid.v4;
        }
        // make crypto easier
        const keccak = str => {
            if (IS_NODEJS) {
                let hash = createKeccakHash('keccak256');
                hash.update(str);
                return hash.digest('hex');
            } else {
                return window.keccak256(str);
            }
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
        class NetNode extends EE {
            log(...args) {
                args.unshift((this.name || 'very sad node without a name'));
                args[0] += ' : ';
                if (IS_NODEJS) console.log.apply(console, args);
            }
            connectPeer(address) {
                // create an outgoing websocket connection to address
                if (IS_NODEJS) {
                    let ws = new uws(address),
                        me = this;
                    ws.on('open', () => {
                        // make life a little easier
                        ws.ip = ws._socket.remoteAddress;
                        ws.port = ws._socket.remotePort;
                        ws.family = ws._socket.remoteFamily;
                        console.log(chalk.green.bold('new outboud peer "' + ws.ip + ":" + ws.port + '"'));
                        me.emit('newPeer', ws);
                        me.send(ws, 'listenport', {
                            port: me._port
                        });
                        this.outPeers.push(ws);
                        ws.peerType = 'out';
                        ws.id = uuidv4();
                    }).on('close', () => {
                        me.handleClose(ws);
                    }).on('message', msg => {
                        me.recv(ws, msg);
                    }).on('error', err => {
                        console.log('WARN: got an outbound peer socket error:');
                        console.log(err);
                    });
                } else {
                    let ws = new window.WebSocket(address),
                        me = this;
                    ws.onopen = () => {
                        let urlParser = document.createElement('a');
                        urlParser.href = address;
                        ws.ip = urlParser.hostname;
                        ws.port = (parseInt(urlParser.port) || null);
                        ws.family = '';
                        // console.log('new outboud peer "' + ws.ip + ":" + ws.port + '"');
                        me.emit('newPeer', ws);
                        me.send(ws, 'listenport', {});
                        this.outPeers.push(ws);
                        ws.peerType = 'out';
                        ws.id = uuidv4();
                    }
                    ws.onclose = () => {
                        me.handleClose(ws);
                    }
                    ws.onerror = e => {
                        console.log('WARN: got an outbound peer socket error:');
                        console.log(err);
                    }
                    ws.onmessage = msg => {
                        me.recv(ws, msg.data);
                    }
                }
            }
            constructor(listenPort, node) {
                super();
                this.node = node;
                this._port = listenPort;
                this.outPeers = []; // sockets we connect to
                this.inPeers = []; // sockets that connect to us
                if (IS_NODEJS) { // only node can host websocket servers
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
            handshake(peer) {
                this.send(peer, 'handshake', {
                    version: PROTOCOL_VERSION
                });
            }
            isConnectedTo(ip) {
                let totalPeers = this.outPeers.concat(this.inPeers);
                for (let i = 0; i < totalPeers.length; ++i) {
                    const strPeer = totalPeers[i].ip + ':' + totalPeers[i].listenPort;
                    if (ip == strPeer) return true;
                }
                return false;
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
                    case 'handshake':
                        if (data.version) {
                            if (data.version < PROTOCOL_VERSION) {
                                // outdated peer
                                me.send(peer, 'outdated', {});
                                console.log('WARN : killed outdated peer');
                                me.shutdown(peer);
                                return;
                            }
                        } else {
                            // malformed packet, kill peer
                            me.shutdown(peer);
                        }
                        break;
                    case 'outdated':
                        // todo : validate authenticity of outdated packets
                        console.warn('peer claims node is outdated!');
                        break;
                    case 'listenport':
                        // if (me.isConnectedTo(peer.ip + ':' + data.port)) me.shutdown(peer);
                        if (!data.port) {
                            peer.listenPort = null;
                            peer.isWeb = true;
                        }
                        peer.listenPort = data.port;
                        break;
                    case 'getaddr':
                        // Get all connected peers and send to client
                        let peerList = [];
                        let totalPeers = this.outPeers.concat(this.inPeers);
                        for (let i = 0; i < totalPeers.length; ++i) {
                            if (totalPeers[i].peerType == 'out' && !totalPeers[i].listenPort) continue;
                            if (totalPeers[i].isWeb) continue; // web nodes can't listen for connections
                            const port = (totalPeers[i].listenPort || totalPeers[i].port);
                            let strPeer = totalPeers[i].ip + ':' + port;
                            strPeer = strPeer.replace('::ffff:', '');
                            if (totalPeers[i].ip == peer.ip && port == peer.port) continue;
                            if (!peerList.includes(strPeer)) {
                                peerList.push(strPeer);
                            }
                        }
                        me.send(peer, 'gotaddr', peerList);
                        break;
                    case 'gotaddr':
                        // handle getaddr response
                        if (data instanceof Array) {
                            me.emit('peerList', data);
                        } else {
                            console.log('got bad getaddr response');
                        }
                        break;
                    case 'newblk':
                        if (!(data.ts ||
                              data.last ||
                              data.txs ||
                              data.pos ||
                              data.nonce ||
                              data.hash)) {
                                // invalid data
                                me.shutdown(peer);
                                return;
                        }
                        let blk = Block.from(data);
                        if (!blk) {
                            // invalid data
                            me.shutdown(peer);
                            return;
                        }
                        me.emit('block', blk);
                        break;
                    case 'tx':
                        if (!(
                            data.i ||
                            data.o ||
                            data.value ||
                            data.t ||
                            data.sig
                        )) {
                            // invalid data
                            me.shutdown(peer);
                            return;
                        }
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
                        if (!data instanceof Array) {
                            // invalid data
                            me.shutdown(peer);
                            return;
                        }
                        let bc = BlockChain.from(data);
                        if (!bc) {
                            // invalid data
                            me.shutdown(peer);
                            return;
                        }
                        me.emit('blockchain', bc);
                        break;
                    case 'getblk':
                        if (!data.n) break;
                        let requestedBlock = me.node.bc.at(data.n);
                        me.send(peer, 'gotblk', requestedBlock.serialize());
                        break;
                    case 'gotblk':
                        let recvBlock = Block.from(data);
                        if (!recvBlock) {
                            // invalid data
                            me.shutdown(peer);
                            return;
                        }
                        me.emit('recievedBlock', recvBlock);
                        break;
                    default:
                        console.warn('Recieved unknown protocol operation "' + obj.op + '"');
                        break;
                }
            }
            // force close peer
            shutdown(peer) {
                if (IS_NODEJS) console.log(chalk.red.bold("shutting down remote peer '" + peer.ip + ':' + peer.port + "'"));
                peer.close();
            }
            // handle peer close
            handleClose(peer) {
                if (IS_NODEJS) console.log(chalk.red('lost connection to peer "' + peer.ip + ':' + peer.port));
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
                return new Transaction(txData.i, txData.o, txData.value, txData.t, txData.sig);
            }
            constructor(sourceAddr, destAddr, value, time, signature) {
                this.source = sourceAddr;
                this.dest = destAddr;
                this.value = value;
                this.ts = time;
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
                return keccak(this.source + this.dest + this.value + this.ts);
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
                    'sig': this.sig,
                    't': this.ts
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
                    if (!(
                        data.txs[i].i ||
                        data.txs[i].o ||
                        data.txs[i].value ||
                        data.txs[i].t ||
                        data.txs[i].sig
                    )) {
                        // invalid data
                        return null;
                    }
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
            let tx = new Transaction('genesis', '0435ef20199d5d2c434b57359af163271c9835c58094b101688978c5f9b478036e873af47d12c75e5d7cc02ff0d62ef8b04e4965d4f65214d87823696728761fdc', 1000, 1514764801);
            genesisTxs.push(tx);
        }
        const GENESIS_BLOCK = new Block(1514764800 * 1000, '', genesisTxs, 0);
        delete genesisTxs;
        
        class BlockChain {
            static from(data) {
                if (!data.bc) return;
                if (typeof data.bc !== 'string') return;
                let strChain;
                try {
                    if (IS_NODEJS) {
                        strChain = pako.inflate(data.bc, {
                            to: 'string'
                        });
                    } else {
                        strChain = window.pako.inflate(data.bc, {
                            to: 'string'
                        });
                    }
                } catch (e) {
                    // inflation failed
                    return null;
                }
                // parse inflated string into usable object
                data = JSON.parse(strChain);
                let chain = [];
                for (let i = 0; i < data.length; ++i) {
                    if (!(data[i].ts ||
                          data[i].last ||
                          data[i].txs ||
                          data[i].pos ||
                          data[i].nonce ||
                          data[i].hash)) {
                            // invalid data
                            return null;
                    }
                    let blk = Block.from(data[i]);
                    if (!blk) return null;
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
                let thisDiff = this.calcDiffAt(blk.pos);
                let validBits = '0'.repeat(thisDiff),
                    hashBits = blk.hash.substring(0, thisDiff);
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
                    return 'wrong last hash';
                }
                
                if (blk.transactions[0].source !== 'reward' ||
                    blk.transactions[0].value !== this.calcRewardAt(blk.pos)) {
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
                let strOut = JSON.stringify(out);
                // deflate with pako
                if (IS_NODEJS) {
                    strOut = pako.deflate(strOut, {
                        to: 'string'
                    });
                } else {
                    strOut = window.pako.deflate(strOut, {
                        to: 'string'
                    });
                }
                out = {
                    'bc': strOut
                }
                return out;
            }
            hash() {
                // hash blockchain for easy comparison
                let khash = createKeccakHash('keccak256');
                for (let i = 0; i < this.chain.length; ++i) {
                    khash.update(this.chain[i].hash);
                }
                return khash.digest('hex');
            }
            equals(bc2) {
                // compare two block chains using their hashes
                return this.hash() === bc2.hash();
            }
            calcDiffAt(height) {
                let baseDiff = 1;
                for (let i = 0; i < height; ++i) {
                    if (i % DIFF_DOUBLE_AT == 0) {
                        baseDiff *= 2; // half every BLOCK_REWARD_HALF_AT blocks
                    }
                }
                return Math.ceil(baseDiff);
            }
            calcDiff() {
                return this.calcDiffAt(this.height());
            }
            calcReward() {
                return this.calcRewardAt(this.height());
            }
            calcRewardAt(height) {
                let baseReward = 100;
                for (let i = 0; i < height; ++i) {
                    if (i % BLOCK_REWARD_HALF_AT == 0) {
                        baseReward /= 2; // half every BLOCK_REWARD_HALF_AT blocks
                    }
                }
                return Math.ceil(baseReward);
            }
        }
        class GafNode extends EE {
            balance(addr) {
                if (addr) return this.bc.balance(addr);
                return this.bc.balance(this.wallet.address);
            }
            transfer(dest, amount) {
                if (!dest || !amount) throw new Error('invalid args');
                let me = this,
                    tx = new Transaction(me.wallet.address, dest, amount, Date.now());
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
            isTxPending(tx) {
                let h = tx.hash;
                for (let i = 0; i < this.pendingTxs.length; ++i) {
                    if (h == this.pendingTxs[i].hash) return true;
                }
                return false;
            }
            constructor(port, privateKey = null) {
                super();
                let me = this;
                this.port = port;
                this.net = new NetNode(port, this);
                this.bc = new BlockChain();
                this.wallet = new Wallet(privateKey);
                this.isMiner = true;
                this.isSyncronized = false;
                this.pendingTxs = [];
                this.peerCount = 0;
                this.gotFirstPeer = false;
                this.lastMinedBlock = null;
                this.net.on('block', blk => {
                    if (blk.pos < me.bc.chain.length) { // this block old and should be ignored
                        return;
                    }
                    let valid = me.bc.validateBlock(blk);
                    if (valid === true) {
                        me.bc.add(blk);
                        if (IS_NODEJS) console.log(chalk.green.bold(`validated and added block #${me.bc.chain.length}`));
                        me.bc.globalDiff = me.bc.calcDiff();
                        me.bc.blockReward = me.bc.calcReward();
                        me.emit('newBlock', blk);
                        // share valid new block with rest of the network
                        me.net.announceBlock(blk);
                    } else {
                        if (IS_NODEJS) console.log(chalk.red.bold('WARN : Recieved invalid block from peer!'));
                        if (IS_NODEJS) console.log(chalk.red.bold('Reason block is invalid: ') + valid);
                        if (IS_NODEJS) console.log(chalk.red.bold('block number: ') + (me.bc.chain.length + 1));
                        me.emit('rejectedBlock', blk);
                    }
                }).on('tx', tx => {
                    if (!tx.validate()) {
                        if (IS_NODEJS) console.log(chalk.red.bold('WARN : Recieved invalid transaction from peer!'));
                        return;
                    }
                    me.net.announceTx(tx); // let everyone know about this new transaction
                    me.emit('newTransaction', tx);
                    if (!me.isMiner) return; // we dont care about new transactions if we're not a miner
                    if (me.isTxPending(tx)) {
                        // duplicate transaction, ignore
                        return;
                    }
                    me.pendingTxs.push(tx);
                    if (me.pendingTxs.length === (BLOCK_SIZE - 1)) {
                        if (me.lastMinedBlock && me.lastMinedBlock == me.bc.chain.length + 1) {
                            // we've already mined this block
                            return;
                        }
                        if (IS_NODEJS) console.log(chalk.yellow.bold(`found new block ${me.bc.chain.length + 1}, mining...`));
                        // create coinbase transaction and add it
                        let coinbaseTx = new Transaction('reward', me.wallet.address, me.bc.blockReward, Date.now());
                        me.pendingTxs.unshift(coinbaseTx);
                        // create a new block and mine it
                        let newBlk = new Block(Date.now(), me.bc.top().calcHash(), me.pendingTxs, me.bc.chain.length);
                        newBlk.mine(me.bc.globalDiff);
                        if (IS_NODEJS) console.log(chalk.green.bold(`block ${me.bc.chain.length + 1} mined successfully. resyncronizing in a few seconds..`));
                        me.net.announceBlock(newBlk);
                        me.emit('minedBlock');
                        // clear pending transactions
                        me.pendingTxs = [];
                        me.lastMinedBlock = me.bc.chain.length + 1;
                        setTimeout(() => {
                            me.sync();
                        }, 5000);
                    }
                }).on('blockchain', bc => {
                    if (bc.height() > me.bc.height()) {
                        let isChainValid = bc.validate(); // validate the integrity of the chain
                        if (isChainValid) {
                            // this blockchain is superior and we need to update ours
                            if (IS_NODEJS) console.log(chalk.green.bold('Switched to newer valid blockchain recieved from peer'));
                            me.bc = bc;
                            me.emit('synced');
                        } else {
                            if (IS_NODEJS) console.log(chalk.red.bold('Rejected invalid blockchain from peer.'));
                            me.emit('syncFail');
                        }
                    }
                }).on('newPeer', peer => {
                    me.peerCount++;
                    if (!me.gotFirstPeer) {
                        me.gotFirstPeer = true;
                        setTimeout(() => {
                            if (IS_NODEJS) console.log(chalk.green.bold('syncing with network'));
                            me.sync();
                        }, 500);
                    }
                    if (IS_NODEJS) console.log(chalk.green.bold('connected to peer, requesting for more peers'));
                    me.net.getPeerPeers(peer);
                    me.emit('connection', peer);
                }).on('lostPeer', peer => {
                    me.peerCount--;
                    me.emit('disconnection', peer);
                }).on('peerList', list => {
                    if (IS_NODEJS) {
                        console.log(chalk.green.bold('recieved list of nodes from peer, attempting to connect to all of them.'));
                    }
                    for (let i = 0; i < list.length; ++i) {
                        if (!me.net.isConnectedTo(list[i])) {
                            if (list[i].startsWith('::1')) list[i] = list[i].replace('::1', '127.0.0.1');
                            let ip = 'ws://' + list[i];
                            me.net.connectPeer(ip);
                        }
                    }
                });
                if (IS_NODEJS) {
                    if (!process.env['IS_INIT_NODE']) {
                        console.log(chalk.green('connecting to INIT_NODE'));
                        me.net.connectPeer(INIT_NODE);
                    }
                } else {
                    me.net.connectPeer(INIT_NODE);
                }
            }
        }
        // network constants
        GafNode.BLOCK_SIZE = BLOCK_SIZE;
        GafNode.BLOCK_REWARD_HALF_AT = BLOCK_REWARD_HALF_AT;
        GafNode.DIFF_DOUBLE_AT = DIFF_DOUBLE_AT;
        GafNode.INIT_NODE = INIT_NODE;
        GafNode.PROTOCOL_VERSION = PROTOCOL_VERSION;
        
        if (IS_NODEJS) {
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
                try {
                    switch (cmd) {
                        case 'help':
                            console.log(chalk.white('commands:'));
                            console.log('clear - clears the screen');
                            console.log('mine - toggles new block mining');
                            console.log('height - displays current blockchain height');
                            console.log('conn / connect [address] - connect to node listening on [address]');
                            console.log('peers - list all active peers');
                            console.log('sync - update blockchain with the network');
                            console.log('address - display wallet address');
                            console.log('private_key - display wallet private key');
                            console.log('balance - display your balance');
                            console.log('transfer [amount] [dest] - transfer [amount] to wallet address [dest]');
                            console.log('port - log the current port the node is listening on');
                            console.log('export [filename] - export blockchain to [filename]');
                            console.log('import [filename] - import blockchain from [filename]');
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
                            let totalPeers = node.net.outPeers.concat(node.net.inPeers);
                            console.log(chalk.yellow('current active peers: ' + (totalPeers).length) + ':');
                            for (let i = 0; i < totalPeers.length; ++i) {
                                process.stdout.write(chalk.white(totalPeers[i].ip + ':' + totalPeers[i].port));
                                process.stdout.write(' ');
                                if (totalPeers[i].isWeb) {
                                    process.stdout.write('(web node)\n');
                                } else {
                                    process.stdout.write('(listening on port ' + totalPeers[i].listenPort + ')\n');
                                }
                            }
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
                            if (!smsg[1] || !smsg[2]) {
                                console.log(chalk.red('invalid arguments'));
                                break;
                            }
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
                            let res;
                            try {
                                res = eval(expr);
                            } catch (e) {
                                res = e.toString();
                            }
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
                        case 'broadconn':
                            node.net.broadcast('getaddr', {});
                            break;
                        case 'printblk':
                            if (!smsg[1] || isNaN(parseInt(smsg[1]))) {
                                console.log(chalk.red('invalid arg'));
                                break;
                            }
                            let blkpos = parseInt(smsg[1]),
                                blk = node.bc.at(blkpos);
                            if (!blk) {
                                console.log(chalk.red('block doesn\'t exist'));
                                break;
                            }
                            console.log(chalk.white('Block ') + chalk.white.bold('"' + blk.hash + '":'));
                            console.log(chalk.white('\t- number: ' + blk.pos));
                            console.log(chalk.white('\t- reward: ' + node.bc.calcRewardAt(blk.pos)));
                            console.log(chalk.white('\t- difficulty: ' + node.bc.calcDiffAt(blk.pos)));
                            console.log(chalk.white('\t- nonce: ' + blk.nonce));
                            break;
                        default:
                            console.log(chalk.red('invalid command, use "help" for a list'));
                            break;
                    }
                } catch (e) {
                    console.log(chalk.red('failed to execute command:'));
                    console.log(chalk.white(e.toString()));
                }
            }
            if (require.main === module) {
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
            }
            module.exports = GafNode;
        }
        if (IS_BROWSER) {
            window.GafNode = GafNode;
        }
    }
    if (IS_NODEJS) init(); // safe to init immediately if node
    else {
        const LOAD_TIME = 500;
        // load all nessacary modules
        let scripts = [
            'https://cdn.rawgit.com/emn178/js-sha3/master/build/sha3.min.js',
            'https://cdn.rawgit.com/indutny/elliptic/master/dist/elliptic.min.js',
            "https://cdnjs.cloudflare.com/ajax/libs/node-uuid/1.4.8/uuid.min.js",
            'https://cdnjs.cloudflare.com/ajax/libs/pako/1.0.6/pako.min.js',
            'https://cdn.rawgit.com/Olical/EventEmitter/master/EventEmitter.min.js'
        ];
        let loadedScripts = 0;
        let onScriptLoad = () => {
            loadedScripts++;
            if (loadedScripts === scripts.length) {
                setTimeout(() => {
                    init(); // everything ready to go
                }, LOAD_TIME);
            }
        }
        for (let i = 0; i < scripts.length; ++i) {
            let scr = document.createElement('script');
            scr.src = scripts[i];
            scr.type = 'text/javascript';
            scr.onload = onScriptLoad();
            document.head.appendChild(scr);
        }
    }
})();