// constants (may make configurable later)
const P2P_PORT = 9284,
    P2P_TEST_PORT = 9285; // to run 2 nodes on one computer

// imports
const crypto = require('crypto'),
    net = require('net'),
    uws = require("uws"),
    keccak = require("keccak");

// net
class NetNode {
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
        }).on('close', () => {
            // also todo
        }).on('message', msg => {
            // ALSO todo
        }).on('error', err => {
            // todo
        });
        this.outPeers.push(ws);
    }
    constructor(listenPort) {
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
        });
    }
    // outbound data
    send(peer, data) {
        if (typeof data !== 'object') {
            throw new Error('can only send json to peers');
        }
        peer.send(JSON.parse(data));
    }
    // inbound data
    recv(peer, msg) {
        this.log('i got a message lol');
    }
}

let n1 = new NetNode(P2P_PORT),
    n2 = new NetNode(P2P_TEST_PORT);
n1.name = 'node1';
n2.name = 'node2';
setTimeout(() => {
    n1.log('connecting to node 2');
    n1.connectPeer('ws://127.0.0.1:' + P2P_TEST_PORT);
}, 200);