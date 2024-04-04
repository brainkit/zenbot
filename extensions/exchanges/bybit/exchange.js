const ccxt = require('ccxt'), path = require('path')
  // eslint-disable-next-line no-unused-vars
  , colors = require('colors'), _ = require('lodash')

const fs = require('node:fs')

module.exports = function bybit(conf) {
  var public_client, authed_client


  function publicClient() {
    if (!public_client) public_client = new ccxt.bybit({
      'apiKey': '', 'secret': '', 'options': {'adjustForTimeDifference': true}
    })
    return public_client
  }

  function authedClient() {
    if (!authed_client) {
      if (!conf.bybit || !conf.bybit.key || conf.bybit.key === 'YOUR-API-KEY') {
        throw new Error('please configure your bybit credentials in ' + path.resolve(__dirname, 'conf.js'))
      }

      authed_client = new ccxt.bybit({
        'apiKey': conf.bybit.key,
        'secret': conf.bybit.secret,
        'options': {'adjustForTimeDifference': true},
        enableRateLimit: true
      })
    }
    return authed_client
  }

  function retry(method, args, err) {
    if (method !== 'getTrades') {
      console.error(('\nbybit API is down! unable to call ' + method + ', retrying in 20s').red)

      if (err) console.error(err)
      console.error(args.slice(0, -1))
    }

    setTimeout(function () {
      exchange[method].apply(exchange, args)
    }, 20000)
  }

  var orders = {}

  var exchange = {
    name: 'bybit', historyScan: 'forward', historyScanUsesTime: true, makerFee: 0.1, takerFee: 0.1,
    PER_DAY_MLS_COUNT: 86400000, TIME_SLICE_MLS_COUNT: 120000,

    getProducts: function () {
      return require('./products.json')
    },

    fetchOHLCV: function (args, cb) {
      var func_args = [].slice.call(arguments)

      args.client.fetchOHLCV(args.symbol, undefined, args.new_start_time, args.trades_limit, args.args)
      .then(list => {
        if (list.length)
          for (var i = 0; i < list.length; i++) {
            if (list[i] !== undefined && list[i][0] !== undefined) {
              var kline = {
                id: list[i][0],
                timestamp: list[i][0],
                amount: parseFloat(list[i][5]),
                price: parseFloat(list[i][1]),
              }

              this.all_OHLCV.push(kline)
            }
          }

        if (this.all_OHLCV.length !== 0 && list.length !== 0) {
          args.new_start_time = this.all_OHLCV[this.all_OHLCV.length - 1].timestamp + 1
          this.fetchOHLCV(args, cb)
        } else {
          last_start_time = this.time_interval_right_boundary
          cb(list.length)
        }
      })
      .catch(function (error) {
        console.error('An error occurred', error)
        return retry('fetchOHLCV', func_args)
      })
    },

    fetchTrades: function (args, cb) {
      args.client.fetchTrades(args.symbol, args.new_start_time, args.trades_limit, args.args)
      .then(list => {
        if (Array.isArray(list) && list.length > 0) {
          list.forEach(elmn => {
            if (elmn.id !== undefined && !this.trades_unique_ids.includes(elmn.id)) {
              this.trades_unique_ids.push(elmn.id)
              this.fetched_trades.push(elmn)
            }
          })
        }

        cb()
      })
      .catch(function (error) {
        console.error('An error occurred', error)
        return retry('fetchTrades', func_args)
      })
    },

    fetchTradesByKlines: function (args, cb) {
      args.kline_idx = 1

      sub_cb = () => {
        if (args.kline_idx < this.all_OHLCV.length - 1) {
          console.log("args.kline_idx " + args.kline_idx)
          console.log("args.new_start_time " + args.new_start_time)

          var kline = this.all_OHLCV[args.kline_idx]

          if (args.new_start_time + this.TIME_SLICE_MLS_COUNT >= kline.timestamp) {
            args.new_start_time = kline.timestamp
            ++args.kline_idx
          } else
            args.new_start_time += this.TIME_SLICE_MLS_COUNT

          this.fetched_trades.push(kline)

          this.fetchTrades(args, sub_cb)

        } else
          cb()
      }

      this.fetchTrades(args, sub_cb)
    },

    getTrades: function (opts, cb) {
      var client = publicClient()

      var trades_limit = typeof opts.limit !== undefined ? opts.limit : 1000

      this.time_interval_right_boundary = (new Date()).getTime()

      console.log(opts)

      if (opts.from)
        last_start_time = opts.from
      else
        last_start_time = this.time_interval_right_boundary - this.PER_DAY_MLS_COUNT

      const symbol = opts.product_id.replace("-", "/")

      this.fetched_trades = []
      this.trades_unique_ids = []

      this.all_trades = []

      this.calls_count = 0
      this.returns_count = 0
      this.all_OHLCV = []

      var params = {
        symbol: symbol,
        new_start_time: last_start_time,
        trades_limit: trades_limit,
        args: {category: "linear"},
        client: client
      }

      var all_trades_getter = new Promise((resolve, reject) => {
        if (last_start_time < this.time_interval_right_boundary) {
          params.new_start_time = last_start_time
          this.fetchOHLCV(params, () => {
            resolve(this.all_OHLCV)
          })
        }
      })


      all_trades_getter.then(result => {
        console.log("klines count: " + result.length)

        var klines_processed = new Promise((resolve, reject) => {
          if (Array.isArray(this.all_OHLCV) && this.all_OHLCV.length !== 0) {
            kline_time = this.all_OHLCV[0].timestamp

            console.log("fetching trades by kline time " + kline_time)

            params.new_start_time = kline_time

            this.fetchTradesByKlines(params, () => {
              resolve(this.fetched_trades)
            })
          } else
            resolve(this.fetched_trades)
        })

        klines_processed.then(result => {
          var trades = result.map(trade => ({
            trade_id: trade.id,
            time: trade.timestamp,
            size: parseFloat(trade.amount),
            price: parseFloat(trade.price),
            side: trade.side
          }))

          trades.sort(function compareFunction(a, b) {
            return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0)
          })
          /*
                    trades.forEach(trade => {
                      fs.appendFileSync('/var/www/zenbot/zen_test.txt', JSON.stringify(trade) + "\r\n", {flag: 'a'}, err => {
                        if (err) {
                          console.error(err);
                        } else {
                          // file written successfully
                        }
                      });
                    })
          */
          cb(null, trades)
        })
      })
    },

    getBalance: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()

      var args = {}

      if (typeof opts.type !== undefined)
        args.type = opts.type

      client.fetchBalance(args).then(result => {
        var balance = {asset: 0, currency: 0}

        Object.keys(result).forEach(function (key) {
          if (key === opts.currency) {
            balance.currency = result[key].free + result[key].used
            balance.currency_hold = result[key].used
          }

          if (key === opts.asset) {
            balance.asset = result[key].free + result[key].used
            balance.asset_hold = result[key].used
          }
        })

        cb(null, balance)
      })
      .catch(function (error) {
        console.error('An error occurred', error)
        return retry('getBalance', func_args)
      })
    },

    getQuote: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()

      var args = {}

      if (typeof opts.baseCoin !== undefined)
        args.baseCoin = opts.baseCoin

      if (typeof opts.expDate !== undefined)
        args.expDate = opts.expDate

      client.fetchTicker(opts.product_id.replace("-", "/"), args)
      .then(result => {
        cb(null, {bid: result.bid, ask: result.ask})
      })
      .catch(function (error) {
        console.error('An error occurred', error)

        return retry('getQuote', func_args)
      })
    },

    getDepth: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()

      var args = {}

      var limit = undefined

      if (typeof opts.limit !== undefined)
        limit = opts.limit

      args.category = typeof opts.category !== undefined ? opts.category : "linear" //spot, linear, inverse, option

      client.fetchOrderBook(opts.product_id.replace("-", "/"), limit, args).then(result => {
        cb(null, result)
      })
      .catch(function (error) {
        console.error('An error ocurred', error)
        return retry('getDepth', func_args)
      })
    },

    cancelOrder: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()

      client.cancelOrder(opts.order_id, opts.product_id.replace("-", "/"))
      .then(function (body) {

          console.log(body)

          process.stop(0)

          if (body && (body.status !== 'Order already done' || body.message === 'order not found'))
            return cb()

          cb(null)
        },
        function (err) {
          // match error against string:
          // "bybit {"code":-2011,"msg":"UNKNOWN_ORDER"}"

          if (err)
            if (err.message && err.message.match(new RegExp(/-2011|UNKNOWN_ORDER/)))
              console.error(('\ncancelOrder retry - unknown Order: ' + JSON.stringify(opts) + ' - ' + err).cyan)
            else
              return retry('cancelOrder', func_args, err) // retry is allowed for this error

          cb()
        })
    },

    buy: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()

      if (typeof opts.post_only === 'undefined')
        opts.post_only = true

      opts.type = 'limit'

      var args = {}

      if (opts.order_type === 'taker') {
        delete opts.post_only
        opts.type = 'market'
      } else
        args.timeInForce = 'GTC'

      opts.side = 'buy'
      delete opts.order_type
      var order = {}

      client.createOrder(opts.product_id.replace("-", "/"), opts.type, opts.side, this.roundToNearest(opts.size, opts), opts.price, args)
      .then(result => {
        if (result && result.message === 'Insufficient funds') {
          order = {
            status: 'rejected', reject_reason: 'balance'
          }
          return cb(null, order)
        }
        order = {
          id: result ? result.id : null, //
          status: 'open',
          price: opts.price,
          size: this.roundToNearest(opts.size, opts),
          post_only: !!opts.post_only,
          created_at: new Date().getTime(),
          filled_size: '0',
          ordertype: opts.order_type
        }

        console.log(order)
        process.stop(0)
        orders['~' + result.id] = order
        cb(null, order)
      })
      .catch(function (error) {
        console.error('An error occurred', error)

        // decide if this error is allowed for a retry:
        // {"code":-1013,"msg":"Filter failure: MIN_NOTIONAL"}
        // {"code":-2010,"msg":"Account has insufficient balance for requested action"}

        if (error.message.match(new RegExp(/-1013|MIN_NOTIONAL|-2010/))) {
          return cb(null, {
            status: 'rejected', reject_reason: 'balance'
          })
        }

        return retry('buy', func_args)
      })
    },

    sell: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()

      if (typeof opts.post_only === 'undefined')
        opts.post_only = true

      opts.type = 'limit'
      var args = {}

      if (opts.order_type === 'taker') {
        delete opts.post_only
        opts.type = 'market'
      } else
        args.timeInForce = 'GTC'

      opts.side = 'sell'
      delete opts.order_type
      var order = {}

      client.createOrder(opts.product_id.replace("-", "/"), opts.type, opts.side, this.roundToNearest(opts.size, opts), opts.price, args)
      .then(result => {
        if (result && result.message === 'Insufficient funds') {
          order = {status: 'rejected', reject_reason: 'balance'}

          return cb(null, order)
        }

        order = {
          id: result ? result.id : null,
          status: 'open',
          price: opts.price,
          size: this.roundToNearest(opts.size, opts),
          post_only: !!opts.post_only,
          created_at: new Date().getTime(),
          filled_size: '0',
          ordertype: opts.order_type
        }

        orders['~' + result.id] = order
        cb(null, order)
      })
      .catch(function (error) {
        console.error('An error occurred', error)

        // decide if this error is allowed for a retry:
        // {"code":-1013,"msg":"Filter failure: MIN_NOTIONAL"}
        // {"code":-2010,"msg":"Account has insufficient balance for requested action"}

        if (error.message.match(new RegExp(/-1013|MIN_NOTIONAL|-2010/))) {
          return cb(null, {
            status: 'rejected', reject_reason: 'balance'
          })
        }

        return retry('sell', func_args)
      })
    },

    roundToNearest: function (numToRound, opts) {
      var numToRoundTo = _.find(this.getProducts(), {
        'asset': opts.product_id.split('-')[0], 'currency': opts.product_id.split('-')[1]
      }).min_size

      numToRoundTo = 1 / (numToRoundTo)

      return Math.floor(numToRound * numToRoundTo) / numToRoundTo
    },

    getOrder: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      var order = orders['~' + opts.order_id]

      client.fetchOrder(opts.order_id, opts.product_id.replace("-", "/")).then(function (body) {
          if (body.status !== 'open' && body.status !== 'canceled') {
            order.status = 'done'
            order.done_at = new Date().getTime()
            order.price = parseFloat(body.price)
            order.filled_size = parseFloat(body.amount) - parseFloat(body.remaining)
            return cb(null, order)
          }
          cb(null, order)
        },
        function (err) {
          return retry('getOrder', func_args, err)
        })
    },

    getCursor: function (trade) {
      return (trade.time || trade)
    }
  }


  return exchange
}
