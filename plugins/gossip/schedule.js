'use strict'
const ip = require('ip')
const onWakeup = require('on-wakeup')
const onNetwork = require('on-change-network')
const hasNetwork = require('../../lib/has-network-debounced')

const pull = require('pull-stream')

function not (fn) {
  return a => !fn(a)
}

function and () {
  var args = [].slice.call(arguments)
  return function (value) {
    // FIXME: useless use of call? maybe...
    return args.every(function (fn) { return fn.call(null, value) })
  }
}

// min delay (delay since last disconnect of most recent peer in unconnected set)
// unconnected filter delay peer < min delay
function delay (failures, factor, max) {
  return Math.min(Math.pow(2, failures) * factor, max || Infinity)
}

function maxStateChange (M, peer) {
  return Math.max(M, peer.stateChange || 0)
}

function peerNext (peer, opts) {
  return (peer.stateChange | 0) + delay(peer.failure | 0, opts.factor, opts.max)
}

// detect if not connected to wifi or other network
// (i.e. if there is only localhost)
function isOffline ({host}) {
  return (
    !ip.isLoopback(host) &&
    host !== 'localhost' &&
    !hasNetwork()
  )
}

const isOnline = not(isOffline)

function isLocal ({host, source}) {
  // don't rely on private ip address, because
  // cjdns creates fake private ip addresses.
  // ignore localhost addresses, because sometimes they get broadcast.
  return !ip.isLoopback(host) && ip.isPrivate(host) && source === 'local'
}

function isSeed ({source}) {
  return source === 'seed'
}

function isFriend ({source}) {
  return source === 'friends'
}

function isUnattempted ({stateChange}) {
  return !stateChange
}

// select peers which have never been successfully connected to yet,
// but have been tried.
function isInactive (peer) {
  return peer.stateChange && (!peer.duration || peer.duration.mean === 0)
}

function isLongterm (peer) {
  return peer.ping && peer.ping.rtt && peer.ping.rtt.mean > 0
}

// peers which we can connect to, but are not upgraded.
// select peers which we can connect to, but are not upgraded to LT.
// assume any peer is legacy, until we know otherwise...
function isLegacy (peer) {
  return peer.duration && (peer.duration && peer.duration.mean > 0) && !exports.isLongterm(peer)
}

// Peers which are connecting or connected
function isConnect ({state}) {
  return state === 'connected' || state === 'connecting'
}

// sort oldest to newest then take first limit
function earliest (peers, limit = 0) {
  return peers
    .sort((a, b) => a.stateChange - b.stateChange)
    .slice(0, Math.max(limit, 0))
}

function select (peers, timestamp, filter, opts) {
  if (opts.disable) return []
  // opts: { quota, groupMin, min, factor, max }
  var type = peers.filter(filter)
  var unconnect = type.filter(not(isConnect))
  var count = Math.max(opts.quota - type.filter(isConnect).length, 0)
  var min = unconnect.reduce(maxStateChange, 0) + opts.groupMin
  if (timestamp < min) return []

  return earliest(unconnect.filter(function (peer) {
    return peerNext(peer, opts) < timestamp
  }), count)
}

exports = module.exports =
function (gossip, config, server) {
  const min = 60e3
  const hour = 60 * 60e3
  var closed = false

  // trigger hard reconnect after suspend or local network changes
  onWakeup(gossip.reconnect)
  onNetwork(gossip.reconnect)

  function conf (name, def) {
    if (config.gossip == null) return def
    var value = config.gossip[name]
    return (value == null || value === '') ? def : value
  }

  function connect (peers, timestamp, name, filter, opts) {
    opts.group = name
    const connected = peers.filter(isConnect).filter(filter)

    // disconnect if over quota
    if (connected.length > opts.quota) {
      return earliest(connected, connected.length - opts.quota)
        .forEach(peer => gossip.disconnect(peer))
    }

    // will return [] if the quota is full
    const selected = select(peers, timestamp, and(filter, isOnline), opts)
    selected.forEach(peer => gossip.connect(peer))
  }

  var lastMessageAt
  server.post(({value}) => {
    if (value.author !== server.id) lastMessageAt = Date.now()
  })

  function isCurrentlyDownloading () {
    // don't schedule gossip if currently downloading messages
    return (lastMessageAt && lastMessageAt > Date.now() - 500)
  }

  var connecting = false
  function connections () {
    if (connecting || closed) return
    connecting = true
    var timer = setTimeout(function () {
      connecting = false

      // don't attempt to connect while migration is running
      if (!server.ready() || isCurrentlyDownloading()) return

      var timestamp = Date.now()
      var peers = gossip.peers()

      var connected = peers.filter(and(isConnect, not(isLocal), not(isFriend))).length

      var connectedFriends = peers.filter(and(isConnect, isFriend)).length

      if (conf('seed', true)) {
        connect(peers, timestamp, 'seeds', isSeed, {
          quota: 3, factor: 2e3, max: 10 * min, groupMin: 1e3
        })
      }

      if (conf('local', true)) {
        connect(peers, timestamp, 'local', isLocal, {
          quota: 3, factor: 2e3, max: 10 * min, groupMin: 1e3
        })
      }

      if (conf('global', true)) {
        // prioritize friends
        connect(peers, timestamp, 'friends', and(exports.isFriend, exports.isLongterm), {
          quota: 2, factor: 10e3, max: 10 * min, groupMin: 5e3
        })

        if (connectedFriends < 2) {
          connect(peers, timestamp, 'attemptFriend', and(exports.isFriend, exports.isUnattempted), {
            min: 0, quota: 1, factor: 0, max: 0, groupMin: 0
          })
        }

        connect(peers, timestamp, 'retryFriends', and(exports.isFriend, exports.isInactive), {
          min: 0,
          quota: 3,
          factor: 60e3,
          max: 3 * 60 * 60e3,
          groupMin: 5 * 60e3
        })

        // standard longterm peers
        connect(peers, timestamp, 'longterm', and(
          exports.isLongterm,
          not(exports.isFriend),
          not(exports.isLocal)
        ), {
          quota: 2, factor: 10e3, max: 10 * min, groupMin: 5e3
        })

        if (!connected) {
          connect(peers, timestamp, 'attempt', exports.isUnattempted, {
            min: 0, quota: 1, factor: 0, max: 0, groupMin: 0
          })
        }

        // quota, groupMin, min, factor, max
        connect(peers, timestamp, 'retry', exports.isInactive, {
          min: 0,
          quota: 3,
          factor: 5 * 60e3,
          max: 3 * 60 * 60e3,
          groupMin: 5 * 50e3
        })

        const longterm = peers.filter(isConnect).filter(isLongterm).length

        connect(peers, timestamp, 'legacy', exports.isLegacy, {
          quota: 3 - longterm,
          factor: 5 * min,
          max: 3 * hour,
          groupMin: 5 * min
        })
      }

      peers.filter(isConnect).forEach(connectedPeer => {
        const permanent = exports.isLongterm(connectedPeer) || exports.isLocal(connectedPeer)
        if ((!permanent || connectedPeer.state === 'connecting') && connectedPeer.stateChange + 10e3 < timestamp) {
          gossip.disconnect(connectedPeer)
        }
      })
    }, 100 * Math.random())
    if (timer.unref) timer.unref()
  }

  pull(
    gossip.changes(),
    pull.drain(({type}) => {
      if (type === 'disconnect') connections()
    })
  )

  const int = setInterval(connections, 2e3)
  if (int.unref) int.unref()

  connections()

  return function onClose () {
    closed = true
  }
}

exports.isUnattempted = isUnattempted
exports.isInactive = isInactive
exports.isLongterm = isLongterm
exports.isLegacy = isLegacy
exports.isLocal = isLocal
exports.isFriend = isFriend
exports.isConnectedOrConnecting = isConnect
exports.select = select
