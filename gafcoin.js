// constants (may make configurable later)
const P2P_PORT = 9284;

// imports
const crypto = require('crypto'),
    net = require('net'),
    uws = require("uws"),
    keccak = require("keccak");