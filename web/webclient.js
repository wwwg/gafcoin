window.write = msg => {
    let e = document.createElement('div');
    e.innerHTML = msg;
    document.getElementById('log').appendChild(e);
};
window.updateStats = () => {
    const stats = document.getElementById('stats');
    document.getElementById('peerCount').textContent = node.net.outPeers.length;
    document.getElementById('bcHeight').textContent = node.bc.height();
    document.getElementById('address').textContent = node.wallet.address;
}
window.getprivate = () => {
    window.prompt('your private key:', node.wallet.private);
}
setTimeout(() => {
    window.node = new GafNode();
    node.on('connection', peer => {
        write('connected to new peer');
    }).on('disconnection', peer => {
        write('lost connection to peer');
    }).on('synced', () => {
        write('successfully synced to network');
        write('blockchain height: ' + node.bc.height());
        updateStats();
    }).on('minedBlock', () => {
        write('mined a block');
    }).on('newTransaction', tx => {
        write('recieved new transaction "' + tx.hash + '"');
    }).on('newBlock', blk => {
        write('added new block "' + blk.hash + '"');
    }).on('syncFail', () => {
        write('sync failure');
    });
}, 2000);