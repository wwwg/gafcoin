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
    EventEmitter = require('events');
// make hashing easier
const keccak = str => {
    let hash = createKeccakHash('keccak256');
    hash.update(str);
    return hash.digest('hex');
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
// components of a blockchain
class Transaction {
    constructor(input, output, value) {
        this.input = input;
        this.output = output;
        this.value = value;
    }
}
class Block {
    constructor(time, pos, lastHash, transactions) {
        this.position = pos;
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

// create a virtual network for testing stuff
console.log('creating virtual testnet...');
let network = [];
const NETWORK_SIZE = 6;
// setup node
let setupNode = node => {
    node.on('newPeer', peer => {
        //
    }).on('lostPeer', peer => {
        //
    });
}
for (let i = 0; i < NETWORK_SIZE; ++i) {
    // create nodes for the network
    let node = new NetNode(9301 + i);
    node.name = 'node' + i;
    setupNode(node);
    network.push(node);
}
// connect all the nodes to each other after the network is created
setTimeout(() => {
    console.log('connecting nodes to each other...');
    for (let i = 0; i < NETWORK_SIZE; ++i) {
        let currNode = network[i];
        for (let i2 = 0; i2 < NETWORK_SIZE; ++i2) {
            let currPort = 9301 + i2;
            if (currPort != currNode._port) { // dont connect a node to itself
                currNode.connectPeer('ws://127.0.0.1:' + currPort);
            }
        }
    }
    let mnode = network[0]; // The master node holds the genesis block
}, 300);