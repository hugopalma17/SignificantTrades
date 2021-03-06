import Vue from 'vue'
import Axios from 'axios'

import Kraken from '../exchanges/kraken'
import Bitmex from '../exchanges/bitmex'
import Coinex from '../exchanges/coinex'
import Huobi from '../exchanges/huobi'
import Binance from '../exchanges/binance'
import Bitfinex from '../exchanges/bitfinex'
import Bitstamp from '../exchanges/bitstamp'
import Gdax from '../exchanges/gdax'
import Hitbtc from '../exchanges/hitbtc'
import Okex from '../exchanges/okex'
import Poloniex from '../exchanges/poloniex'

import store from '../services/store'
import Liquid from '../exchanges/liquid';

const emitter = new Vue({
	data() {
		return {
			API_URL: null,
			PROXY_URL: null,

			exchanges: [
				new Bitmex(),
				new Bitfinex(),
				new Coinex(),
				new Binance(),
				new Gdax(),
				new Huobi(),
				new Bitstamp(),
				new Hitbtc(),
				new Okex(),
				new Poloniex(),
				new Liquid()
			],

			trades: [],
			timestamps: {},
			queue: [],

			_pair: null
		}
	},
  computed: {
    pair() {
      return store.state.pair
    },
    timeframe() {
      return store.state.timeframe
    },
		exchangesSettings() {
			return store.state.exchanges
		},
		actives() {
			return store.state.actives
		},
    showChart() {
      return store.state.showChart
    },
    chartRange() {
      return store.state.chartRange
    },
    showCounters() {
      return store.state.showCounters
    },
    countersSteps() {
      return store.state.countersSteps
    },
  },
	created() {
		window.emitTrade = (exchange, price, amount, side, type = null) => {
			exchange = exchange || 'bitmex';

			if (price === null) {
				price = this.getExchangeById(exchange).price;
			}

			amount = amount || 1;
			side = side || 1;

			let trade = [exchange, +new Date(), price, amount, side ? 1 : 0, type]

			this.queue = this.queue.concat([trade]);

			this.emitFilteredTradesAndVolumeSum([trade]);
		}

		this.exchanges.forEach(exchange => {
			exchange.on('live_trades', (trades) => {
				if (!trades || !trades.length) {
					return;
				}

				this.timestamps[exchange.id] = +new Date();

				trades = trades
					.sort((a, b) => a[1] - b[1]);

				this.queue = this.queue.concat(trades);

				this.emitFilteredTradesAndVolumeSum(trades);
			});

			exchange.on('open', event => {
				console.log(`[socket.exchange.on.open] ${exchange.id} opened`);

				this.$emit('connected', exchange.id);
			});

			exchange.on('close', event => {
				console.log(`[socket.exchange.on.close] ${exchange.id} closed`);

				this.$emit('disconnected', exchange.id);

				if (exchange.shouldBeConnected && !this.exchangesSettings[exchange.id].disabled) {
					exchange.reconnect(this.pair);
				}
			});

			exchange.on('match', pair => {
				console.log(`[socket.exchange.on.match] ${exchange.id} matched ${pair}`);
				store.commit('setExchangeMatch', {
					exchange: exchange.id,
					match: pair
				})
			});

			exchange.on('error', event => {
				console.log(`[socket.exchange.on.error] ${exchange.id} reported an error`);

				/* if (!this.errors[exchange.id]) {
					this.errors[exchange.id] = 0;
				}

				this.errors[exchange.id]++;

				this.$emit('exchange_error', exchange.id, this.errors[exchange.id]); */
			});

			store.commit('reloadExchangeState', exchange.id);
		})
	},
	methods: {
		initialize() {
			console.log(`[sockets] initializing ${this.exchanges.length} exchange(s)`);

			if (process.env.API_URL) {
				this.API_URL = process.env.API_URL;
				console.info(`[sockets] API_URL = ${this.API_URL}`);
			}

			if (process.env.PROXY_URL) {
				this.PROXY_URL = process.env.PROXY_URL;
				console.info(`[sockets] PROXY_URL = ${this.PROXY_URL}`);
			}

			this.connectExchanges();

			setInterval(() => {
				if (!this.queue.length) {
					return;
				}

				this.trades = this.trades.concat(this.queue);

				this.emitFilteredTradesAndVolumeSum(this.queue, 'trades.queued');

				this.queue = [];
			}, 1000);
		},
		connectExchanges(pair = null) {
			this.disconnectExchanges();

			if (pair) {
				this.pair = pair;
			}

			this.trades = this.queue = [];
			this.timestamps = {};

			console.log(`[socket.connect] connecting to "${this.pair}"`);

			this.$emit('alert', {
				id: `server_status`,
				type: 'info',
				title: `Loading`,
				message: `Fetching products...`
			});

			Promise.all(this.exchanges.map(exchange => exchange.validatePair(this.pair))).then(() => {
				let validExchanges = this.exchanges.filter(exchange => exchange.valid);

				this.$emit('alert', {
					id: `server_status`,
					type: 'info',
					title: `Loading`,
					message: `Matching "${pair}" exchanges...`
				});

				if (!validExchanges.length) {
					return;
				}

				if (this._pair !== this.pair) {
					this.$emit('pairing', this.pair, this.canFetch());

					this._pair = this.pair;
				}

				validExchanges = validExchanges.filter(exchange => !this.exchangesSettings[exchange.id].disabled);

				console.log(`[socket.connect] ${validExchanges.length} successfully matched with "${this.pair}"`);

				if (this.canFetch()) {
					this.$emit('alert', {
						id: `server_status`,
						type: 'info',
						title: `Loading`,
						message: 'Fetch last 60s...'
					});
				}

				console.log(`[socket.connect] connect exchanges asynchronously`);

				validExchanges.forEach(exchange => exchange.connect());

				this.$emit('alert', {
					id: `server_status`,
				});
			});
		},
		disconnectExchanges() {
			console.log(`[socket.connect] disconnect exchanges asynchronously`);

			this.exchanges.forEach(exchange => exchange.disconnect());
		},
		clean() {
			let requiredTimeframe = 0;

			if (this.showChart && this.chartRange) {
				requiredTimeframe = Math.max(requiredTimeframe, this.chartRange * 2);
			}

			console.log('socket.clean', 'requiredTimeframe', requiredTimeframe);

			const minTimestamp = +new Date() - requiredTimeframe;

			console.log(`[socket.clean] remove trades older than ${new Date(minTimestamp)}`);

			let i;

			for (i = 0; i < this.trades.length; i++) {
				if (this.trades[i][1] > minTimestamp) {
					break;
				}
			}

			this.trades.splice(0, i);

			this.$emit('clean', minTimestamp)
		},
		getExchangeById(id) {
			for (let exchange of this.exchanges) {
				if (exchange.id === id) {
					return exchange;
				}
			}

			return null;
		},
		emitFilteredTradesAndVolumeSum(trades, event = 'trades.instant') {
			let upVolume = 0;
			let downVolume = 0;

			const output = trades.filter(a => {
				if (this.actives.indexOf(a[0]) === -1) {
					return false;
				}

				if (a[4]) {
					upVolume += a[3];
				} else {
					downVolume += a[3];
				}

				return true;
			})

			this.$emit(event, output, upVolume, downVolume);
		},
		canFetch() {
			return this.API_URL && /btcusd/i.test(this.pair);
		},
		fetchRangeIfNeeded(range, timeframe) {
			const now = +new Date();

      let promise;
			let from = now - range;
			let to = !this.trades.length ? now : this.trades[0][1];

			from = Math.floor(from / timeframe) * timeframe;
			to = Math.ceil(to / timeframe) * timeframe;

      if (to - from >= 60000 && this.canFetch() && (!this.trades.length || this.trades[0][1] > from)) {
				console.info(`[socket.fetchRangeIfNeeded]`, `FETCH NEEDED\n\n\tcurrent time: ${new Date(now)}\n\tfrom: ${new Date(from)}\n\tto: ${new Date(to)} (${this.trades.length ? 'using first trade as base' : 'using now for reference'})`);

        promise = this.fetchHistoricalData(from, to, true);
      } else {
        promise = Promise.resolve(null);
      }

			return promise;
		},
		fetchHistoricalData(from, to) {
			if (!from || !to || !this.canFetch()) {
				return Promise.resolve();
			}

			const url = `${process.env.API_URL ? process.env.API_URL : ''}${parseInt(from)}/${parseInt(to)}`;

			if (this.lastFetchUrl === url) {
				return Promise.resolve();
			}

			this.lastFetchUrl = url;

			return new Promise((resolve, reject) => {
				Axios.get(url, {
					onDownloadProgress: e => this.$emit('fetchProgress', {
						loaded: e.loaded,
						total: e.total,
						progress: e.loaded / e.total
					})
				})
					.then(response => {
						let fetchedTrades = response.data;

						const count = this.trades.length;

						if (!this.trades.length) {
							console.log(`[fetch] set socket.trades (${this.trades} trades)`);

							this.trades = fetchedTrades;
						} else {
							const prepend = fetchedTrades.filter(trade => trade[1] <= this.trades[0][1]);
							const append = fetchedTrades.filter(trade => trade[1] >= this.trades[this.trades.length - 1][1]);

							if (prepend.length) {
								console.log(`[fetch] prepend ${prepend.length} trades`);
								this.trades = prepend.concat(this.trades);
							}

							if (append.length) {
								console.log(`[fetch] append ${append.length} trades`);
								this.trades = this.trades.concat(append);
							}
						}

						if (count !== this.trades.length) {
							this.$emit('historical', fetchedTrades, from, to);
						}

						resolve(fetchedTrades);
					})
					.catch(err => {
						err && this.$emit('alert', {
							type: 'error',
							title: `Unable to retrieve history`,
							message: err.response && err.response.data && err.response.data.error ? err.response.data.error : err.message,
							id: `fetch_error`
						});

						reject();
					})
			});
		},
		commitQueueAndRefreshListeners() {
			console.log('socket:commitQueueAndRefreshListeners');
			if (this.queue.length) {
				this.trades = this.trades.concat(this.queue);

				this.queue = [];
			}

			store.commit('setTimeframe', this.timeframe);
		}
	}
});

export default emitter;