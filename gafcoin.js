(() => {
    // network constants (may make configurable later)
    const BLOCK_SIZE = 30, // number of transactions that make a block
        INIT_NODE = 'ws://198.58.119.239:9284', // original node; hard coded into every node
        GENESIS_REBIRTH = 10, // height at which to perform a blockchain rebirth
        PROTOCOL_VERSION = 8; // proto version; versions lower than this are rejected by nodes

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
        EC,
        express,
        bodyParser;
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
        express = require('express');
        bodyParser = require('body-parser');
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
        }, compress = data => {
            if (IS_NODEJS) {
                return pako.deflate(data, {
                    'to': 'string'
                });
            } else {
                return window.pako.deflate(data, {
                    'to': 'string'
                });
            }
        }, decompress = data => {
            if (IS_NODEJS) {
                return pako.inflate(data, {
                    'to': 'string'
                });
            } else {
                return window.pako.inflate(data, {
                    'to': 'string'
                });
            }
        }, round = x => {
            return parseFloat(x.toFixed(8));
        };
        
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
                        if (!me.firstPeer) me.firstPeer = ws;
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
                        if (!me.firstPeer) me.firstPeer = ws;
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
                this.firstPeer = null;
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
                        if (!me.firstPeer) me.firstPeer = ws;
                        
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
                if (op !== 'tx' && peer.txListen) {
                    return; // only broadcast transactions
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
            announceRebirth(genesisBlock) {
                let blk = genesisBlock.serialize();
                // compress for network
                let outData = {
                    'blk': ''
                };
                outData.blk = compress(JSON.stringify(blk));
                this.broadcast('rebirthblk', outData);
            }
            reqBlockChain() {
                this.broadcast('getbc', {});
            }
            reqBlock(blockNum) {
                if (!this.firstPeer) return;
                this.send(this.firstPeer, 'getblk', {
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
            reqTxListen() {
                // will tell peers that this node only wants to recieve incoming transactions
                this.broadcast('txlisten', {});
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
                    case 'rebirthblk':
                        if (!data.blk) {
                            console.log('WARN : peer sent invalid data');
                            me.shutdown(peer);
                            return;
                        }
                        let decompressedBlk;
                        try {
                            decompressedBlk = decompress(data.blk);
                        } catch (e) {
                            me.shutdown(peer);
                            return;
                        }
                        let newBlk = RebirthBlock.from(JSON.parse(decompressedBlk));
                        me.emit('rebirthBlock', newBlk);
                        break;
                    case 'txlisten':
                        peer.txListen = true;
                        break;
                    case 'outdated':
                        me.emit('outdated');
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
                        if (typeof data.n === "undefined" || data.n > me.node.bc.height() - 1) {
                            break;
                        }
                        let rBlock = me.node.bc.at(data.n);
                        let requestedBlock = rBlock.serialize();
                        requestedBlock = JSON.stringify(requestedBlock);
                        // compress for network
                        let outData = {
                            'blk': ''
                        };
                        outData.blk = compress(requestedBlock);
                        if (rBlock.pos == me.node.bc.height() - 1) {
                            outData.isTop = 1;
                        }
                        me.send(peer, 'gotblk', outData);
                        break;
                    case 'gotblk':
                        if (!data.blk) {
                            me.shutdown(peer);
                            return;
                        }
                        let blkData = data.blk;
                        try {
                            blkData = decompress(blkData);
                        } catch(e) {
                            // invalid data
                            me.shutdown(peer);
                            return;
                        }
                        blkData = JSON.parse(blkData);
                        let recvBlock = Block.from(blkData);
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
                if (!ECVerify(this.source, this.hash, this.sig)) return false;
                if (this.source == this.dest) return false;
                return true;
            }
            serialize() {
                return {
                    'i': this.source,
                    'o': this.dest,
                    'value': round(this.value),
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
            size() {
                // returns the size of the transaction in bytes
                return JSON.stringify(this.serialize()).length;
            }
        }
        class Block {
            static genesisChain(bc) {
                // analyzes blockchain and compresses it into a single block
                let addressMap = {}; // A map of addresses to their balance
                // perform address mapping
                for (let x = 0; x < bc.height(); ++x) {
                    let blk = bc.at(x);
                    for (let y = 0; y < blk.transactions.length; ++y) {
                        let tx = blk.transactions[y];
                        if (!addressMap[tx.source]) {
                            let srcBalance = bc.balance(tx.source);
                            if (srcBalance > 0)
                                addressMap[tx.source] = srcBalance;
                        }
                        if (!addressMap[tx.dest]) {
                            let destBalance = bc.balance(tx.dest);
                            if (destBalance > 0)
                                addressMap[tx.dest] = destBalance;
                        }
                    }
                }
                let genesisTxs = [];
                let now = Date.now();
                // convert address map into array of transactions
                for (const addr in addressMap) {
                    const balance = addressMap[addr];
                    let tx = new Transaction('', addr, balance, now);
                    genesisTxs.push(tx);
                }
                // create block from transaction array
                let gblk = new Block(now, '', genesisTxs, 0);
                return gblk;
            }
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
                this.isGenesis = (this.lastHash === '');
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
            size() {
                // returns the size of the block in bytes
                return JSON.stringify(this.serialize()).length;
            }
        }
        class RebirthBlock extends Block {
            static fromBlock(blk, signedBy) {
                return new RebirthBlock(blk.time, blk.lastHash, blk.transactions, blk.pos, blk.nonce, signedBy);
            }
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
                return new RebirthBlock(data.ts, data.last, txs, data.pos, data.nonce, data.from, data.signature);
            }
            constructor(time, lastHash, transactions, pos, nonce, from, _signature) {
                super(time, lastHash, transactions, pos, nonce);
                if (!from) throw new Error('address needed to sign block');
                this.signedBy = from;
                if (_signature) {
                    this.signature = _signature;
                    this.signed = true;
                } else {
                    this.signature = null;
                    this.signed = false;
                }
                this.hash = this.calcHash();
            }
            verifyWithChain(blockchain) {
                if (!this.verify()) return false;
                for (let i = 0; i < this.transactions.length; ++i) {
                    let tx = this.transactions[i],
                        thisAddr = tx.dest,
                        newBalance = tx.value,
                        oldBalance = blockchain.balance(thisAddr);
                    if (newBalance !== oldBalance) {
                        return false;
                    }
                }
                return true;
            }
            sign(privateKey) {
                if (this.signed) throw new Error('already signed block');
                this.hash = this.calcHash();
                this.signature = ECSign(privateKey, this.hash);
                this.signed = true;
                return this.signature;
            }
            verify() {
                if (!this.signed) throw new Error('unsigned block');
                return ECVerify(this.signedBy, this.hash, this.signature);
            }
            serialize() {
                if (!this.signed) throw new Error('unsigned block');
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
                    'hash': this.hash,
                    'signature': this.signature,
                    'from': this.signedBy
                }
            }
        }
        // create genesis block, which is hardcoded into every client
        let genesisTxs = [];
        for (let i = 0; i < BLOCK_SIZE; ++i) {
            let tx = new Transaction('', '0435ef20199d5d2c434b57359af163271c9835c58094b101688978c5f9b478036e873af47d12c75e5d7cc02ff0d62ef8b04e4965d4f65214d87823696728761fdc', 1.66666667, 1514764801);
            genesisTxs.push(tx);
        }
        const GENESIS_BLOCK = new Block(1514764800 * 1000, '', genesisTxs, 0);
        GENESIS_BLOCK.isGenesis = true;
        delete genesisTxs;
        
        class BlockChain {
            static from(data) {
                if (!data.bc) return;
                if (typeof data.bc !== 'string') return;
                let strChain;
                try {
                    strChain = decompress(data.bc);
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
                
                if (blk.transactions[0].source !== '' ||
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
                let _hash = blk.hash;
                for (let i = 0; i < this.chain.length; ++i) {
                    let thisBlk = this.chain[i];
                    if (thisBlk.hash == _hash) return 'duplicate block';
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
                strOut = compress(strOut);
                out = {
                    'bc': strOut
                }
                return out;
            }
            hash() {
                // hash blockchain for easy comparison
                let hashSum = '';
                for (let i = 0; i < this.chain.length; ++i) {
                    hashSum += (this.chain[i].hash);
                }
                return keccak(hashSum);
            }
            hasTransaction(tx) {
                let hash;
                if (tx instanceof Transaction) {
                    hash = tx.hash;
                } else if (typeof tx === 'string') {
                    hash = tx;
                } else {
                    throw new Error('invalid args');
                }
                for (let x = 0; x < this.chain.length; ++x) {
                    let blk = this.chain[x];
                    for (let y = 0; y < blk.length; ++y) {
                        let _tx = blk.transactions[y];
                        if (_tx.hash == hash) return true;
                    }
                }
                return false;
            }
            equals(bc2) {
                // compare two block chains using their hashes
                return this.hash() === bc2.hash();
            }
            calcDiffAt(height) {
                return Math.floor(1 / (-0.0099 * (height - 40)));
            }
            calcDiff() {
                return this.calcDiffAt(this.height());
            }
            calcReward() {
                return this.calcRewardAt(this.height());
            }
            calcRewardAt(height) {
                let supply = this.totalSupplyAt(height);
                // block reward is a function of the amount of coins in circulation
                let reward = 1.0007 ** (-(supply - 15000));
                reward = round(reward);
                return reward;
            }
            byteLength() {
                // returns the size of the blockchain in bytes
                return JSON.stringify(this.serialize()).length;
            }
            swapWith(blk) {
                this.chain = [blk];
                this.globalDiff = this.calcDiff();
                this.blockReward = this.calcReward();
            }
            get totalSupply() {
                // analyzes blockchain to find how many coins are in circulation
                let addressMap = {}; // A map of addresses to their balance
                // perform address mapping
                for (let x = 0; x < this.height(); ++x) {
                    let blk = this.at(x);
                    for (let y = 0; y < blk.transactions.length; ++y) {
                        let tx = blk.transactions[y];
                        if (!addressMap[tx.source]) {
                            let srcBalance = this.balance(tx.source);
                            if (srcBalance > 0)
                                addressMap[tx.source] = srcBalance;
                        }
                        if (!addressMap[tx.dest]) {
                            let destBalance = this.balance(tx.dest);
                            if (destBalance > 0)
                                addressMap[tx.dest] = destBalance;
                        }
                    }
                }
                // sum every value in the address map to get the total coins in the network
                let sum = 0;
                for (let addr in addressMap) {
                    let balance = addressMap[addr];
                    sum += balance;
                }
                return sum;
            }
            totalSupplyAt(height) {
                // analyzes blockchain to find how many coins are in circulation at specified height
                let addressMap = {}; // A map of addresses to their balance
                // perform address mapping
                for (let x = 0; x < height; ++x) {
                    let blk = this.at(x);
                    for (let y = 0; y < blk.transactions.length; ++y) {
                        let tx = blk.transactions[y];
                        if (!addressMap[tx.source]) {
                            let srcBalance = this.balance(tx.source);
                            if (srcBalance > 0)
                                addressMap[tx.source] = srcBalance;
                        }
                        if (!addressMap[tx.dest]) {
                            let destBalance = this.balance(tx.dest);
                            if (destBalance > 0)
                                addressMap[tx.dest] = destBalance;
                        }
                    }
                }
                // sum every value in the address map to get the total coins in the network
                let sum = 0;
                for (let addr in addressMap) {
                    let balance = addressMap[addr];
                    sum += balance;
                }
                return sum;
            }
        }
        class GafNode extends EE {
            balance(addr) {
                if (addr) return this.bc.balance(addr);
                return this.bc.balance(this.wallet.address);
            }
            transfer(dest, amount) {
                if (!dest || !amount) throw new Error('invalid args');
                amount = round(amount);
                if (dest == this.wallet.address) throw new Error('source and dest cant be the same');
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
                this.blkPosNeeded = this.bc.height();
                // request for needed block
                this.net.reqBlock(this.blkPosNeeded);
            }
            isTxPending(tx) {
                let h = tx.hash;
                for (let i = 0; i < this.pendingTxs.length; ++i) {
                    if (h == this.pendingTxs[i].hash) return true;
                }
                return false;
            }
            createRebirthBlk() {
                let genesis = Block.genesisChain(this.bc);
                let diff = this.bc.globalDiff * 2; // block with the most work put into it will be chosen
                genesis.mine(diff);
                let blk = RebirthBlock.fromBlock(genesis, this.wallet.address);
                blk.sign(this.wallet.private);
                return blk;
            }
            rebirth() {
                let blk = this.createRebirthBlk();
                this.net.announceRebirth(blk);
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
                this.blkPosNeeded = 0;
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
                        if (me.bc.height() >= GENESIS_REBIRTH && me.isMiner) {
                            me.rebirth();
                        }
                    } else {
                        if (IS_NODEJS) console.log(chalk.red.bold('WARN : Recieved invalid block from peer!'));
                        if (IS_NODEJS) console.log(chalk.red.bold('Reason block is invalid: ') + valid);
                        if (IS_NODEJS) console.log(chalk.red.bold('block number: ') + (me.bc.chain.length + 1));
                        me.emit('rejectedBlock', blk);
                    }
                })
                .on('tx', tx => {
                    if (!tx.validate()) {
                        if (IS_NODEJS) console.log(chalk.red.bold('WARN : Recieved invalid transaction from peer!'));
                        return;
                    }
                    if (me.bc.hasTransaction(tx)) return;
                    if (me.isTxPending(tx)) return; // duplicate
                    me.net.announceTx(tx); // let everyone know about this new transaction
                    me.emit('newTransaction', tx);
                    me.pendingTxs.push(tx);
                    if (me.pendingTxs.length === (BLOCK_SIZE - 1)) {
                        if (!me.isMiner) {
                            me.pendingTxs = []; // if we're not a miner we can clear the tx cache
                            return; // no more needs to be done
                        }
                        if (me.lastMinedBlock && me.lastMinedBlock == me.bc.chain.length + 1) {
                            // we've already mined this block
                            return;
                        }
                        if (IS_NODEJS) console.log(chalk.yellow.bold(`found new block ${me.bc.chain.length + 1}, mining...`));
                        // create coinbase transaction and add it
                        let coinbaseTx = new Transaction('', me.wallet.address, me.bc.blockReward, Date.now());
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
                })
                .on('newPeer', peer => {
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
                })
                .on('lostPeer', peer => {
                    me.peerCount--;
                    me.emit('disconnection', peer);
                })
                .on('peerList', list => {
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
                })
                .on('recievedBlock', blk => {
                    // validate and add to top of the chain
                    let valid = me.bc.validateBlock(blk);
                    if (!valid) {
                        if (IS_NODEJS) {
                            console.log(chalk.red.bold("rejected block: " + valid));
                        }
                        me.emit('invalidBlock', blk);
                        me.net.reqBlock(me.blkPosNeeded);
                        return;
                    }
                    me.bc.add(blk);
                    if (IS_NODEJS) {
                        console.log(chalk.green(`new block #${blk.pos}, hash "${blk.hash}"`));
                    }
                    me.emit('addedBlock', blk);
                    me.blkPosNeeded = me.bc.height();
                    me.net.reqBlock(me.blkPosNeeded);
                })
                .on('outdated', () => {
                    me.emit('outdated');
                })
                .on('rebirthBlock', rblk => {
                    if (me.bc.height() >= GENESIS_REBIRTH) {
                        // block can be considered valid
                        let isValid = rblk.verifyWithChain(me.bc);
                        if (!isValid) {
                            if (IS_NODEJS) console.log(chalk.red.bold('rejected invalid rebirth block'));
                            return;
                        };
                        // blockchain can be replaced with this block
                        me.bc.swapWith(rblk);
                        me.emit('rebirth', rblk);
                        me.net.announceRebirth(rblk); // spread the block throughout the network
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
        // network objects
        GafNode.Block = Block;
        GafNode.Transaction = Transaction;
        GafNode.BlockChain = BlockChain;
        GafNode.Wallet = Wallet;
        GafNode.Network = NetNode;
        
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
                console.log('node gafcoin.js  [ -k <key> --http-port <http port>] -p <port>');
                console.log('where <port> is a tcp port to listen on');
                console.log('and <key> is optionally a private key to use for your wallet.');
                console.log('if an http port is provided, an http server will be started on port <http port> and will allow you to use the gafcoin http api.');
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
            let httpPort;
            if (args['http-port']) {
                httpPort = parseInt(args['http-port']);
                if (isNaN(httpPort)) httpPort = null;
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
                            console.log('printblk [blknum] - print block # [blknum]');
                            console.log('cleartxs - clear pending transaction cache');
                            console.log('pending - print number of pending txs');
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
                                console.log(chalk.green('transfering ' + amount + ' to "' + dest + '"'));
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
                        case "cleartxs":
                            node.pendingTxs = [];
                            console.log(chalk.green('Cleared pending transactions'));
                            break;
                        case "pending":
                            console.log(chalk.yellow(`pending txs: ${node.pendingTxs.length}`));
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
                let app = express();
                app.use(bodyParser.json());
                app.use(bodyParser.urlencoded({ extended: true }));
                app.get('/', (req, res) => {
                    res.send({
                        BLOCK_SIZE,
                        BLOCK_REWARD_HALF_AT,
                        DIFF_DOUBLE_AT,
                        INIT_NODE,
                        PROTOCOL_VERSION
                    });
                }).get('/blockhash/:hash', (req, res) => {
                    let blkHash = req.params.hash;
                    if (!blkHash) {
                        res.status(404).send('not found');
                        return;
                    } else {
                        let blk;
                        for (let i = 0; i < node.bc.height(); ++i) {
                            let thisBlk = node.bc.at(i);
                            if (thisBlk.hash == blkHash) {
                                blk = thisBlk;
                                break;
                            }
                        }
                        if (!blk) {
                            res.status(404).send('not found');
                            return;
                        } else {
                            res.send(blk.serialize());
                        }
                    }
                }).get('/block/:number', (req, res) => {
                    let num = req.params.number;
                    if (!num) {
                        res.status(404).send('not found');
                        return;
                    }
                    let blk;
                    try {
                        blk = node.bc.at(num);
                    } catch (e) {
                        res.status(404).send('not found');
                        return;
                    }
                    if (blk) {
                        res.send(blk.serialize());
                    } else {
                        res.status(404).send('not found');
                        return;
                    }
                }).get('/network', (req, res) => {
                    res.send({
                        height: node.bc.height(),
                        difficulty: node.bc.globalDiff,
                        reward: node.bc.blockReward,
                        pendingTxs: node.pendingTxs.length
                    });
                }).get('/txpool', (req, res) => {
                    let txs = [];
                    for (let i = 0; i < node.pendingTxs.length; ++i) {
                        txs.push(node.pendingTxs[i].serialize());
                    }
                    res.send(txs);
                }).post('/utransact', (req, res) => {
                    // unsigned transaction
                    let source = req.body.wallet,
                        dest = req.body.to,
                        privateKey = req.body.privateKey,
                        amount = req.body.amount;
                    if (!source || !privateKey || !amount || !dest) {
                        res.status(403).send('bad input');
                        return;
                    }
                    if (typeof amount !== 'number' ||
                        typeof source !== 'string' ||
                        typeof dest !== 'string' ||
                        typeof privateKey !== 'string') {
                            res.status(403).send('bad input');
                            return;
                        }
                    let tx = new Transaction(source, dest, amount, Date.now());
                    try {
                        tx.sign(privateKey);
                    } catch (e) {
                        res.status(403).send('failed to sign transaction');
                        return;
                    }
                    if (!tx.validate()) {
                        res.send('invalid transaction');
                        return;
                    }
                    node.net.announceTx(tx);
                    res.send('success');
                }).post('/transact', (req, res) => {
                    // presigned transaction ; no private key needed
                    let source = req.body.wallet,
                        dest = req.body.to,
                        sig = req.body.signature,
                        amount = req.body.amount;
                    if (!source || !sig || !amount || !dest) {
                        res.status(403).send('bad input');
                        return;
                    }
                    if (typeof amount !== 'number' ||
                        typeof source !== 'string' ||
                        typeof dest !== 'string' ||
                        typeof sig !== 'string') {
                            res.status(403).send('bad input');
                            return;
                        }
                    let tx = new Transaction(source, dest, amount, Date.now(), sig);
                    if (!tx.validate()) {
                        res.status(403).send('invalid signature');
                        return;
                    }
                    node.net.announceTx(tx);
                    res.send('success');
                }).get('/balance/:address', (req, res) => {
                    let addr = req.params.address;
                    if (!addr) {
                        res.send('wrong address');
                        return;
                    }
                    res.send((node.balance(addr)).toString());
                }).post('/submitblock', (req, res) => {
                    let ts = req.body.timestamp,
                        last = req.body.lastHash,
                        rawTxs = req.body.transactions,
                        pos = req.body.position,
                        nonce = req.body.nonce;
                    if (!ts || !last || !rawTxs || !pos || !nonce) {
                        res.status(403).send('bad input');
                        return;
                    }
                    let txs = [];
                    for (let i = 0; i < data.txs.length; ++i) {
                        if (!(
                            rawTxs[i].i ||
                            rawTxs[i].o ||
                            rawTxs[i].value ||
                            rawTxs[i].t ||
                            rawTxs[i].sig
                        )) {
                            // invalid data
                            res.status(403).send('bad transaction');
                            return;
                        }
                        let tx = Transaction.from(rawTxs[i]);
                        txs.push(tx);
                    }
                    let blk = Block.from(ts, last, txs, pos, nonce);
                    if (!blk) {
                        res.status(403).send('bad block');
                        return;
                    }
                    let validation = node.bc.validateBlock(blk);
                    if (validation !== true) {
                        res.status(403).send(`failed to verify block: ${validation}`);
                        return;
                    }
                    node.net.announceBlock(blk);
                    res.send('success');
                });
                if (httpPort) {
                    app.listen(httpPort);
                    console.log(chalk.white.bold(`started http server on port ${httpPort}`));
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
            }
            module.exports = GafNode;
        }
        if (IS_BROWSER) {
            window.GafNode = GafNode;
        }
    }
    if (IS_NODEJS) init(); // safe to init immediately if node
    else {
        const LOAD_TIME = 1000;
        // load all nessacary modules
        let scripts = [
            'scripts/sha3.min.js',
            'scripts/elliptic.min.js',
            "scripts/uuid.min.js",
            'scripts/pako.min.js',
            'scripts/EventEmitter.min.js'
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