const events = require('events')
const _ = require('lodash')
const async = require('async')
const Table = require('./Table')
const mysql = require('mysql')
const ZongJi = require('zongji')

class Ulisse extends events.EventEmitter {
  constructor (conf) {
    super()

    this.conf = conf
    _.extend(this.conf, {
      keepalive: 15000
    })

    this.conf.mysql.supportBigNumbers = true
    this.conf.mysql.bigNumberStrings = true

    this._snapTs = 0
    this.tables = {}
  }

  parse (evt) {
    let query = null
    const cname = evt.constructor.name

    if (evt.query) {
      let statement = evt.query

      if (!this.conf.forwardStatements) {
        statement = null
      }

      if (statement) {
        if (statement.length < 10 || _.startsWith(statement, 'BEGIN') || _.startsWith(statement, 'COMMIT')) {
          statement = null
        }
      }

      if (statement) {
        statement = evt.query.replace(/\\/gm, '')
        query = { text: statement, type: 'statement' }
      }
    } else {
      const tableId = evt.tableId + ''
      let tableName = evt.tableMap && evt.tableMap[tableId] ? evt.tableMap[tableId].tableName : 'unknown'

      if (tableName) {
        query = { table: tableName, rows: evt.rows, type: 'row', op: cname }
        if (query.rows) {
          for (let i = 0; i < query.rows.length; i++) {
            const row = query.rows[i]
            if (!row.before && !row.after) {
              query.rows[i] = { before: row }
            }
          }
        } else {
          query = null
        }
      }
    }

    return query
  }

  table (t) {
    let table = null

    if (this.tables[t]) {
      table = this.tables[t]
    } else {
      table = this.tables[t] = new Table(t)
      table.on('action', evts => {
        this.emit('action', t, evts)
      })
    }

    return table
  }

  reconnectDb () {
    this.cli = mysql.createConnection(this.conf.mysql)

    this.cli.connect(err => {
      if (!err) return

      setTimeout(() => {
        this.reconnectDb()
      }, 2000)
    })

    this.cli.on('error', err => {
      console.error('DB_CLI ERROR', err)
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        this.reconnectDb()
      } else {
        throw err
      }
    })
  }

  start () {
    this.reconnectDb()

    this.binlog = new ZongJi(this.conf.mysql)
    this.binlog.on('binlog', (evt) => {
      const query = this.parse(evt)
      if (!query) return

      if (query.type === 'row') {
        const table = this.table(query.table)
        table.handleRowChange(query)
      } else {
        if (_.indexOf(['BEGIN', 'COMMIT'], query.text) === -1) {
          this.emit('action', 'default', [{ a: 'dbe', o: query }])
        }
      }
    })

    function zerror (err) {
      this.emit('error-critical', err)
    }

    this.binlog.on('error', zerror.bind(this))
    this.binlog.ctrlConnection.on('error', zerror.bind(this))

    setInterval(() => {
      this.cli.ping(function (err) {
        if (err) console.error(err)
      })

      this.binlog.ctrlConnection.ping(function (err) {
        if (err) console.error(err)
      })
    }, this.conf.keepalive)

    this.binlog.start({
      startAtEnd: true,
      includeEvents: ['query', 'rotate', 'tablemap', 'writerows', 'updaterows', 'deleterows'],
      includeSchema: this.conf.schemas || undefined,
      serverId: this.conf.mysql.serverId || 0
    })
  }

  stop () {
  }

  _snap (db, table, cb) {
    if (table.syncing) {
      return cb()
    }

    this._snapTs = Date.now()
    table.syncing = true

    const conn = this.cli

    async.auto({
      db: next => {
        conn.query('USE ' + db, next)
      },
      lock: ['db', (res, next) => {
        table.locked = true
        conn.query('FLUSH TABLES ' + table.name + ' WITH READ LOCK', next)
      }],
      sleep: ['lock', (res, next) => {
        if (!table.locked) return next()
        setTimeout(next, 2500)
      }],
      handle: ['sleep', (res, next) => {
        console.log('QUERY', table.name)
        conn.query('SELECT * FROM ' + table.name, (err, rows) => {
          table.startSnapshot()

          console.log('FLUSH', table.name, rows.length)
          if (_.isArray(rows)) {
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i]
              table.handleRowChange({
                op: 'WriteRows',
                type: 'row',
                table: table.name,
                rows: [{ before: row }]
              })
            }
          }

          table.endSnapshot()
          next(err)
        })
      }],
      unlock: ['handle', (res, next) => {
        if (!table.locked) return next()
        table.locked = false
        conn.query('UNLOCK TABLES', next)
      }]
    }, (err, res) => {
      table.syncing = false
      cb(err)
    })
  }

  snap (db, tables, opts = {}) {
    const aseries = []

    _.each(tables, t => {
      aseries.push(next => {
        const table = this.table(t)
        this._snap(db, table, next)
      })
    })

    console.log('SNAPSHOT START', db, tables)

    async.series(aseries, (err) => {
      console.log('SNAPSHOT END', db, tables, err)
    })
  }
}

module.exports = Ulisse
