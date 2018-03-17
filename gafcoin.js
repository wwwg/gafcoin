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
        args.unshift((this.name || 'very sad node without a name : '));
        console.log.apply(console, args);
    }
    connectPeer(address) {
        // create an outgoing websocket connection to address
        let ws = new uws(address),
            me = this;
        ws.on('open', () => {
            // todo
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
            console.log('recieved new connection from socket:');
            console.log(ws._socket);
        });
    }
}

let n1 = new NetNode(P2P_PORT),
    n2 = new NetNode(P2P_TEST_PORT);
n1.name = 'node1';
n2.name = 'node2';
setTimeout(() => {
    n1.log('connecting to node 2');
}, 200);