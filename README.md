# Hive Smart Contracts [![Build Status](https://travis-ci.org/harpagon210/steemsmartcontracts.svg?branch=master)](https://travis-ci.org/harpagon210/steemsmartcontracts)[![Coverage Status](https://coveralls.io/repos/github/harpagon210/steemsmartcontracts/badge.svg?branch=master)](https://coveralls.io/github/harpagon210/steemsmartcontracts?branch=master)

 ## 1.  What is it?

Hive Smart Contracts is a sidechain powered by Hive, it allows you to perform actions on a decentralized database via the power of Smart Contracts.

 ## 2.  How does it work?

This is actually pretty easy, you basically need a Hive account and that's it. To interact with the Smart Contracts you simply post a message on the Hive blockchain (formatted in a specific way), the message will then be catched by the sidechain and processed.

 ## 3.  Sidechain specifications
- run on [node.js](https://nodejs.org)
- database layer powered by [MongoDB](https://www.mongodb.com/)
- Smart Contracts developed in Javascript
- Smart Contracts run in a sandboxed Javascript Virtual Machine called [VM2](https://github.com/patriksimek/vm2)
- a block on the sidechain is produced only if transactions are being parsed in a Hive block

## 4. Setup a Hive Smart Contracts node

see wiki: https://github.com/harpagon210/steemsmartcontracts/wiki/How-to-setup-a-Steem-Smart-Contracts-node

In addition, the followimg is needed to use transaction framework for MongoDB:
- Run MongoDB in replicated mode. This is as simple as changing the mongo config to add replication config:
  ```
    replication:
      replSetName: "rs0"
  ```
- Need version 3.6 mongo node library.
## 5. Tests
* npm run test

## 6. Usage/docs

* see wiki: https://github.com/harpagon210/steemsmartcontracts/wiki
