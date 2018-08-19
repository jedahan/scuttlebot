const mdm = require('mdmanifest')
const apidoc = require('../../lib/apidocs').gossip

module.exports = {
  name: 'gossip-autofriend',
  version: '1.0.0',
  manifest: mdm.manifest(apidoc),
  permissions: {
    anonymous: {allow: ['ping']}
  },
  init: function (server, config) {
    if (!config.autofriend) return

    if (!server.friends) return server.emit('log:info', ['SBOT', `no friends plugin found?`, 'AUTOFRIEND ERROR'])

    server.on('rpc:connect').hook(fn => {
      const {peer} = fn.args
      if (peer.source === 'local') {
        server.friends.get({dest: peer.key}, (_, found) => {
          if (Object.keys(found).length > 0) return

          server.emit('log:info', ['SBOT', `autofriending new local peer`, 'AUTOFRIEND NEW'])
          const friend = {
            type: 'contact',
            contact: peer.key,
            following: true,
            flagged: { reason: 'autofriend' }
          }
          server.publish(friend, (err, results) => {
            if (err) { server.emit('log:error', ['SBOT', stringify(friend), 'AUTOFRIEND ERROR']) }
            server.emit('log:info', ['SBOT', `autofreinded ${friend.contact}`, 'AUTOFRIEND SUCCESS'])
          })
        })
      }
    })
  }
}
