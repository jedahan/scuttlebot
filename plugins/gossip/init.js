const pull = require('pull-stream')
const ref = require('ssb-ref')

module.exports = function (gossip, config, server) {
  if (config.offline) return void console.log('Running in offline mode: gossip disabled')

  // populate peertable with configured seeds (mainly used in testing)
  const seeds = Array.isArray(config.seeds) ? config.seeds : [config.seeds]

  seeds
    .filter(Boolean)
    .forEach(addr => gossip.add(addr, 'seed'))

  // populate peertable with pub announcements on the feed
  pull(
    server.messagesByType({
      type: 'pub', live: true, keys: false
    }),
    pull.drain(msg => {
      if (msg.sync) return
      if (!msg.content.address) return
      if (ref.isAddress(msg.content.address)) { gossip.add(msg.content.address, 'pub') }
    })
  )

  // populate peertable with announcements on the LAN multicast
  server.on('local', _peer => gossip.add(_peer, 'local'))
}
