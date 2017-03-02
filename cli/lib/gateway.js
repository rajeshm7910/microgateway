'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const edgeconfig = require('microgateway-config');
const gateway = require('microgateway-core');
const reloadCluster = require('./reload-cluster');
const JsonSocket = require('./json-socket');
const configLocations = require('../../config/locations');
const isWin = /^win/.test(process.platform);
const ipcPath = configLocations.getIPCFilePath();
const defaultPollInterval = 100;
const uuid = require('uuid');

const Gateway = function () {
};

module.exports = function () {
  return new Gateway();
};

Gateway.prototype.start =  (options) => {
  const self = this;
  try {
    fs.accessSync(ipcPath, fs.F_OK);
    console.error('Edgemicro seems to be already running.');
    console.error('If the server is not running, it might because of incorrect shutdown of the prevous start.');
    console.error('Try removing ' + ipcPath + ' and start again');
    process.exit(1);
  } catch (e) {
    // Socket does not exist
    // so ignore and proceed
  }

  const args = {pluginDir: options.pluginDir};

  edgeconfig.get({systemConfigPath: options.systemConfigPath, apidEndpoint: options.apidEndpoint},  (err, config) => {
    if (err) {
      if(err.name == 'YAMLException') {
        err.message = err.name + ' ' + err.reason;
      }
      return console.log('Error downloading configuration. Gateway not started. Reason: ', err.message);
    } else {
      if (options.port) {
        config.system.port = parseInt(options.port);
      }
      
      if(options.apidEndpoint && config['analytics-apid']) {
        config['analytics-apid'].apidEndpoint = options.apidEndpoint;
      }
      //edgeconfig.save(config, cache);
      process.env.CONFIG = JSON.stringify(config);

    }

    config.uid = uuid.v1();
    var logger = gateway.Logging.init(config);  
    var opt = {};
    opt.args = [JSON.stringify(args)];
    opt.timeout = 10;
    opt.logger = gateway.Logging.getLogger();
    
    //Let reload cluster know how many processes to use if the user doesn't want the default
    if(options.processes) {
      opt.workers = Number(options.processes);
    }

    var mgCluster = reloadCluster(path.join(__dirname, 'start-agent.js'), opt);

    var server = net.createServer();
    server.listen(ipcPath);

    server.on('connection',  (socket) => {
      socket = new JsonSocket(socket);
      socket.on('message', (message) => {
        if (message.command == 'reload') {
          console.log('Recieved reload instruction. Proceeding to reload');
          mgCluster.reload(() => {
            console.log('Reload completed');
            socket.sendMessage(true);
          });
        } else if (message.command == 'stop') {
          console.log('Recieved stop instruction. Proceeding to stop');
          mgCluster.terminate(() => {
            console.log('Stop completed');
            socket.sendMessage(true);
            process.exit(0);
          });
        } else if (message.command == 'status') {
          var activeWorkers = mgCluster.activeWorkers();
          socket.sendMessage(activeWorkers ? activeWorkers.length : 0);
        }
      });
    });

    mgCluster.run();

    process.on('exit', () => {
      if (!isWin) {
        console.log('Removing the socket file as part of cleanup');
        fs.unlinkSync(ipcPath);
      }
    });

    process.on('SIGTERM', () => {
      process.exit(0);
    });

    process.on('SIGINT', () => {
      process.exit(0);
    });

    var pollInterval = config.system.config_change_poll_interval || defaultPollInterval;
    // Client Socket for auto reload
    // send reload message to socket.
    var clientSocket = new JsonSocket(new net.Socket()); //Decorate a standard net.Socket with JsonSocket
    clientSocket.connect(ipcPath);
    edgeconfig.setRefreshing(clientSocket, pollInterval);
    //start the polling mechanism to look for config changes
  });
};

