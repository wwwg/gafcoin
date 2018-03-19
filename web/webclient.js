window.write = msg => {
    let e = document.createElement('div');
    e.innerHTML = msg;
    document.getElementById('log').appendChild(e);
};
setTimeout(() => {
    window.node = new GafNode();
    node.on('connection', peer => {
        write('connected to new peer');
    }).on('disconnection', peer => {
        write('lost connection to peer');
    }).on('synced', () => {
        write('successfully synced to network');
        write('blockchain height: ' + node.bc.height());
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