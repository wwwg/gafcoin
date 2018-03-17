// constants (may make configurable later)
const P2P_PORT = 9284,
    P2P_TEST_PORT = 9285; // to run 2 nodes on one computer

// imports
const crypto = require('crypto'),
    net = require('net'),
    uws = require("uws"),
    keccak = require("keccak"),
    EventEmitter = require('events');

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
            // also todo
        }).on('message', msg => {
            me.recv(ws, msg);
        }).on('error', err => {
            console.log('WARN: got an outbound peer socket error:');
            console.log(err);
        });
        this.outPeers.push(ws);
        ws.peerIndex = this.outPeers.length - 1;
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
            ws.peerIndex = this.outPeers.length - 1;
            me.emit('newPeer', ws);
            ws.on('message', msg => {
                me.recv(ws, msg);
            });
        });
    }
    // outbound data
    send(peer, data) {
        if (typeof data !== 'object') {
            throw new Error('can only send json to peers');
        }
        peer.send(JSON.stringify(data));
    }
    // inbound data
    recv(peer, msg) {
        let obj;
        try {
            obj = JSON.parse(msg);
        } catch(e) {
            console.log('WARN : failed to parse inbound data:');
            console.log(e);
            return;
        }
        this.log('i got a msg', msg);
    }
}

let n1 = new NetNode(P2P_PORT),
    n2 = new NetNode(P2P_TEST_PORT);
n1.name = 'node1';
n1.on('newPeer', peer => {
    n1.send(peer, {
        'h': 'i'
    });
});
n2.name = 'node2';
setTimeout(() => {
    n1.log('connecting to node 2');
    n1.connectPeer('ws://127.0.0.1:' + P2P_TEST_PORT);
}, 200);