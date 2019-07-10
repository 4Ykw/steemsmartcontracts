/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const { MongoClient } = require('mongodb');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');

const { CONSTANTS } = require('../libs/Constants');

//process.env.NODE_ENV = 'test';

const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;

function send(pluginName, from, message) {
  const plugin = plugins[pluginName];
  const newMessage = {
    ...message,
    to: plugin.name,
    from,
    type: 'request',
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}


// function to route the IPC requests
const route = (message) => {
  const { to, type, jobId } = message;
  if (to) {
    if (to === 'MASTER') {
      if (type && type === 'request') {
        // do something
      } else if (type && type === 'response' && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === 'broadcast') {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error('ROUTING ERROR: ', message);
    }
  }
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(newPlugin.PLUGIN_NAME, 'MASTER', { action: 'init', payload: conf });
};

const unloadPlugin = (plugin) => {
  plugins[plugin.PLUGIN_NAME].cp.kill('SIGINT');
  plugins[plugin.PLUGIN_NAME] = null;
  jobs = new Map();
  currentJobId = 0;
}

let contractCode = fs.readFileSync('./contracts/tokens.js');
contractCode = contractCode.toString();

contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);

let base64ContractCode = Base64.encode(contractCode);

let tknContractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

contractCode = fs.readFileSync('./contracts/witnesses.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_MIN_VALUE\}\$'/g, CONSTANTS.UTILITY_TOKEN_MIN_VALUE);
base64ContractCode = Base64.encode(contractCode);

let witnessesContractPayload = {
  name: 'witnesses',
  params: '',
  code: base64ContractCode,
};

describe('witnesses', function () {
  this.timeout(10000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    })
      .then(() => {
        done()
      })
  });
  
  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    })
      .then(() => {
        done()
      })
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    })
      .then(() => {
        done()
      })
  });

  afterEach((done) => {
      // runs after each test in this block
      new Promise(async (resolve) => {
        await db.dropDatabase()
        resolve();
      })
        .then(() => {
          done()
        })
  });
  
  it.skip('registers witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node.too", "enabled": false, "isSignedWithActiveKey": true }`));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      let witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[0].RPCPUrl, "my.awesome.node");
      assert.equal(witnesses[0].enabled, true);

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[1].RPCPUrl, "my.awesome.node.too");
      assert.equal(witnesses[1].enabled, false);

      transactions = [];
      transactions.push(new Transaction(2, 'TXID5', 'dan', 'witnesses', 'register', `{ "RPCPUrl": "my.new.awesome.node", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(2, 'TXID6', 'vitalik', 'witnesses', 'register', `{ "RPCPUrl": "my.new.awesome.node.too", "enabled": true, "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[0].RPCPUrl, "my.new.awesome.node");
      assert.equal(witnesses[0].enabled, false);

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[1].RPCPUrl, "my.new.awesome.node.too");
      assert.equal(witnesses[1].enabled, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it.skip('approves witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node.too", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID5', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID6', 'harpagon', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID7', 'harpagon', 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      let witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000000');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
            account: 'harpagon'
          }
        }
      });

      let account = res.payload;

      assert.equal(account.approvals, 2);
      assert.equal(account.approvalWeight.$numberDecimal, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      let approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      let params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight.$numberDecimal, "200.00000000");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID8', 'satoshi', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID9', 'harpagon', 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "0.00000001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID10', 'harpagon', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID11', 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID12', 'ned', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      let accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 3);
      assert.equal(accounts[0].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 2);
      assert.equal(accounts[1].approvalWeight.$numberDecimal, "1E-8");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "harpagon");
      assert.equal(approvals[2].to, "satoshi");

      assert.equal(approvals[3].from, "ned");
      assert.equal(approvals[3].to, "dan");

      assert.equal(approvals[4].from, "ned");
      assert.equal(approvals[4].to, "satoshi");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 3);
      assert.equal(params[0].totalApprovalWeight.$numberDecimal, "300.00000002");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it.skip('disapproves witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node.too", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID5', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID6', 'harpagon', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID7', 'harpagon', 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID8', 'satoshi', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID9', 'harpagon', 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "0.00000001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID10', 'harpagon', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID11', 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID12', 'ned', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(1, 'TXID13', 'ned', 'witnesses', 'disapprove', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      let accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 3);
      assert.equal(accounts[0].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight.$numberDecimal, "1E-8");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
            to: "satoshi"
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "satoshi");
      assert.equal(approvals.length, 1);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 3);
      assert.equal(params[0].totalApprovalWeight.$numberDecimal, "300.00000001");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID14', 'harpagon', 'witnesses', 'disapprove', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "0E-8");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight.$numberDecimal, "1E-8");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
            to: "satoshi"
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals.length, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight.$numberDecimal, "200.00000001");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('schedules witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      let txId = 100;
      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, `witness${index}`, 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      for (let index = 0; index < 30; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, 'harpagon', 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
            
          }
        }
      });

      let witnesses = res.payload;

      //console.log(witnesses)

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'schedules',
          query: {
            
          }
        }
      });

      let schedule = res.payload;

      console.log(schedule)

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000000');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
            account: 'harpagon'
          }
        }
      });

      let account = res.payload;

      assert.equal(account.approvals, 2);
      assert.equal(account.approvalWeight.$numberDecimal, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      let approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      let params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight.$numberDecimal, "200.00000000");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID8', 'satoshi', 'witnesses', 'register', `{ "RPCPUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID9', 'harpagon', 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "0.00000001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID10', 'harpagon', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID11', 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID12', 'ned', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      let accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 3);
      assert.equal(accounts[0].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 2);
      assert.equal(accounts[1].approvalWeight.$numberDecimal, "1E-8");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "harpagon");
      assert.equal(approvals[2].to, "satoshi");

      assert.equal(approvals[3].from, "ned");
      assert.equal(approvals[3].to, "dan");

      assert.equal(approvals[4].from, "ned");
      assert.equal(approvals[4].to, "satoshi");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 3);
      assert.equal(params[0].totalApprovalWeight.$numberDecimal, "300.00000002");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
