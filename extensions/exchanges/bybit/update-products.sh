#!/usr/bin/env node
let ccxt = require('ccxt')

new ccxt.bybit().fetchMarkets().then(function(markets) {
  var products = []

  var products = markets.map(function (market) {
   // console.log(market)

    const market_data = market.info

    // NOTE: price_filter also contains minPrice and maxPrice
    return {
      id: market_data.symbol,
      asset: market_data.baseCoin,
      currency: market_data.quoteCoin,
      min_size: market_data.lotSizeFilter.minOrderQty,
      max_size: market_data.lotSizeFilter.maxOrderQty,
      increment: market_data.priceFilter.tickSize,
      asset_increment: market_data.lotSizeFilter.basePrecision,
      label: market_data.baseCoin + '/' + market_data.quoteCoin
    }
  })

  var target = require('path').resolve(__dirname, 'products.json')
  require('fs').writeFileSync(target, JSON.stringify(products, null, 2))
  console.log('wrote', target)
  process.exit()
})
