const ccxt = require('ccxt'), path = require('path')
  // eslint-disable-next-line no-unused-vars
  , colors = require('colors'), _ = require('lodash')

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

  /**
   * Convert BNB-BTC to BNB/BTC
   *
   * @param product_id BNB-BTC
   * @returns {string}

   function joinProduct(product_id) {
    let split = product_id.split('-')
    return split[0] + '/' + split[1]
  }
   */
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

    getProducts: function () {
      return require('./products.json')
    },

    getTrades: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()
      var startTime = null
      var args = {}

      var trades_limit = typeof opts.limit !== undefined ? opts.limit : 1000
      //args.category = typeof opts.category !== undefined ? opts.category : "linear"

      const PER_HOUR_MLS_COUNT = 300000
      var time_interval_left_boundary = null

      var last_start_time = (new Date()).getTime()

      if (opts.to)
        last_start_time = parseInt(opts.to, 10)

      if (!opts.from) {
        time_interval_left_boundary = parseInt(opts.to, 10) - PER_HOUR_MLS_COUNT

        //args['endTime'] = opts.to
      } else
        time_interval_left_boundary = opts.from

      const symbol = opts.product_id.replace("-", "/")

      var new_start_time = null

      var fetched_trades = []

      var all_trades = []

      calls_count = 0
      returns_count = 0

      var all_trades_getter = new Promise((resolve, reject) => {
        while (last_start_time > time_interval_left_boundary) {
          if (time_interval_left_boundary > last_start_time - PER_HOUR_MLS_COUNT)
            new_start_time = time_interval_left_boundary
          else
            new_start_time = last_start_time - PER_HOUR_MLS_COUNT

          console.log("bybit getTrades startTime : " + new_start_time)
          ++calls_count

          client.fetchTrades(symbol, new_start_time, trades_limit, args)
          .then(result => {
            ++returns_count
            fetched_trades = fetched_trades.concat(result)

            if (returns_count === calls_count)
              resolve(fetched_trades)

            //console.log(result)

            return result
          })
          last_start_time = new_start_time - 1
        }
      })

      all_trades_getter.then(result => {

        var trades = result.map(trade => ({
          trade_id: trade.id,
          time: trade.timestamp,
          size: parseFloat(trade.amount),
          price: parseFloat(trade.price),
          side: trade.side
        }))

        cb(null, trades)
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
