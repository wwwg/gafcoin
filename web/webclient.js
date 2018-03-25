window.write = msg => {
    let e = document.createElement('div');
    e.textContent = msg;
    document.getElementById('log').appendChild(e);
};
window.updateStats = () => {
    const stats = document.getElementById('stats');
    document.getElementById('peerCount').textContent = node.net.outPeers.length;
    document.getElementById('bcHeight').textContent = node.bc.height();
    document.getElementById('balance').textContent = node.balance();
    document.getElementById('pendingTxs').textContent = node.pendingTxs.length;
    document.getElementById('reward').textContent = node.bc.blockReward;
    document.getElementById('diff').textContent = node.bc.globalDiff;
    let peers = '';
    for (let i = 0; i < node.net.outPeers.length; ++i) {
        peers += node.net.outPeers[i].ip;
        if (node.net.outPeers[i].ip == "198.58.119.239")
            peers += " (genesis node)";
        peers += "<br>";
    }
    document.getElementById('peers').innerHTML = peers;
}
window.transfer = () => {
    let dest = document.getElementById('destAddr').value;
    let amount = parseInt(document.getElementById('value').value);
    if (isNaN(amount)) return alert('wrong amount');
    if (dest == node.wallet.address) return alert(`source and destination can't be the same`);
    let myBalance = node.balance();
    if (myBalance - amount < 0) return alert('you can\'t afford that');
    node.transfer(dest, amount);
    write('broadcasted transaction');
}
window.sync = () => {
    write('attempting to sync with network..');
    node.sync();
}
window.getprivate = () => {
    let oldKey = node.wallet.private;
    let newKey = window.prompt('your private key (changing will update your wallet):', node.wallet.private);
    if (oldKey == newKey) {
        // private key was not set
        return;
    }
    node.wallet = new (node.wallet.constructor)(newKey);
    localStorage.priv = newKey;
    window.updateStats();
}
window.getwalletaddr = () => {
    window.prompt('your wallet address:', node.wallet.address);
}
setTimeout(() => {
    let pkey;
    if (localStorage.priv) pkey = localStorage.priv;
    window.node = new GafNode(null, pkey);
    if (!localStorage.priv) localStorage.priv = node.wallet.private;
    node.on('connection', peer => {
        write('connected to new peer');
        updateStats();
        setTimeout(updateStats, 1000);
    }).on('disconnection', peer => {
        write('lost connection to peer');
        updateStats();
        setTimeout(updateStats, 1000);
    }).on('synced', () => {
        write('successfully synced to network');
        write('blockchain height: ' + node.bc.height());
        updateStats();
    }).on('minedBlock', () => {
        write('mined a block');
        updateStats();
    }).on('newTransaction', tx => {
        write('recieved new transaction "' + tx.hash + '"');
        window.updateStats();
    }).on('newBlock', blk => {
        write('added new block "' + blk.hash + '"');
        window.updateStats();
    }).on('syncFail', () => {
        write('sync failure');
        updateStats();
    }).on('addedBlock', blk => {
        write('added new block "' + blk.hash + '"');
        updateStats();
    });
}, 2000);