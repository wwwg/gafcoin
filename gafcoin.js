// constants (may make configurable later)
const P2P_PORT = 9284,
    P2P_TEST_PORT = 9285, // to run 2 nodes on one computer
    IS_TEST = !!(process.env['GAF_TEST']);

// imports
const crypto = require('crypto'),
    net = require('net'),
    uws = require("uws"),
    keccak = require("keccak");

// net
class NetNode {
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
            // todo
        });
    }
}

let nnode;
if (IS_TEST) {
    console.log('im a test node yay');
    nnode = new NetNode(P2P_TEST_PORT);
} else {
    console.log('im not a test not yay');
    nnode = new NetNode(P2P_PORT);
}