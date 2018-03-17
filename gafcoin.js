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
    constructor() {
        this.outPeers = []; // sockets we connect to
        this.inPeers = []; // sockets that connect to us
        this.server = new uws.Server({
            port: P2P_PORT
        });
        let s = this.server,
            me = this;
        s.on('connection', ws => {
            // todo
        });
    }
}