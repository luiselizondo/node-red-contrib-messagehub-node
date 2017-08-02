/**
 * Created by fwang1 on 3/25/15.
 */

var MessageHub = require('message-hub-rest');
var Q = require('q');
var cfEnv = require('cfenv');

function buildCredentials(kafkaRestUrl, apiKey) {
  return {
    messagehub: [{
      credentials: {
        api_key:  apiKey,
        kafka_rest_url: kafkaRestUrl
      }
    }]
  };
}

module.exports = function(RED) {
  var appEnv = cfEnv.getAppEnv() || {services: {}};
  var services = [];

  Object.keys(appEnv.services).forEach(function(key) {
    if (key.match(/^(messagehub)/i))
      services.push.apply(services, appEnv.services[key]);
  });

  // make these names available to the node configuration
  RED.httpAdmin.get('/message-hub/vcap', function(req, res) {
    res.json(services);
  });

  RED.httpAdmin.get('/message-hub/service/:nodeId/topics', function(req, res) {
    var nodeId = decodeURIComponent(req.params.nodeId);
    var service = RED.nodes.getNode(nodeId);

    if (!service)
      return res.json([]);

    var instance = new MessageHub(service.getService());

    instance.topics.get()
      .then(function(response) {
        res.json(response);
      })
      .fail(function(error) {
        res.json(error)
      });
  });

  RED.httpAdmin.get('/message-hub/service/:kafkaRestUrl/:apiKey/topics', function(req, res) {
    var kafkaRestUrl = decodeURIComponent(req.params.kafkaRestUrl);
    var apiKey = decodeURIComponent(req.params.apiKey);

    if (!kafkaRestUrl || !apiKey)
      return res.json([]);

    var instance = new MessageHub(buildCredentials(kafkaRestUrl, apiKey));

    instance.topics.get()
      .then(function(response) {
        res.json(response);
      })
      .fail(function(error) {
        res.json(error)
      });
  });

  function MessageHubService(config) {
    RED.nodes.createNode(this, config);

    this.kafkaRestUrl = config.kafkaRestUrl;
    this.service = config.service;
    this.credentials = this.credentials || {};
    this.apiKey = this.credentials.apiKey;

    this.getService = (function() {
      var apiKey = this.apiKey;
      var kafkaRestUrl = this.kafkaRestUrl;
      if (this.service) {
        var serviceName = this.service;
        var service = services.find(function(s) {
          return s.name == serviceName;
        });

        if (service) {
          apiKey = service.credentials.api_key;
          kafkaRestUrl = service.credentials.kafka_rest_url;
        }
      }

      return buildCredentials(kafkaRestUrl, apiKey);
    }).bind(this)
  }

  RED.nodes.registerType('messagehub service', MessageHubService, {
    credentials: {
      apiKey: {type: 'text'}
    }
  });

  /*
   *   MessageHub Producer
   */
  function MessageHubProducer(config) {
    RED.nodes.createNode(this, config);

    var node = this;
    var service = RED.nodes.getNode(config.service);

    var instance = new MessageHub(service.getService());
    var topic = config.topic;

    this.on("input", function(msg) {
      try {
        var payloads = [];

        payloads.push(msg.payload);

        var list = new MessageHub.MessageList(payloads);

        instance.produce(topic, list.messages)
          .then(function(response) {
            msg.payload = response;
            node.send(msg);
          })
          .fail(function(error) {
            msg.error = error;
            node.error("Failed sending messages", msg);
          });
      } catch(e) {
        msg.error = e;
        node.error("Error sending messages", msg);
      }
    });
  }

  RED.nodes.registerType("messagehub out", MessageHubProducer);

  /*
   * Message Hub Consumer
   */
  function MessageHubConsumer(config) {
    RED.nodes.createNode(this,config);

    var node = this;
    node.loop = true;
    var interval = parseInt(config.interval) || 2000;
    var service = RED.nodes.getNode(config.service);

    var instance = new MessageHub(service.getService());
    var topic = config.topic;

    function random() {
      return Math.floor((Math.random() * 100) + 1);
    }

    function getTopicAndSend(consumerInstance) {
      var lastCheck = Date.now();
      if (!node.loop)
        return;

      return consumerInstance
        .get(topic)
        .then(function(data) {
          for (var i=0; i < data.length; i++) {
            node.send({payload: data[i]});
          }
        })
        .fail(function(err) {
          node.error("Error getting topic: '"+topic+"' has failed", {error: err});
        })
        .then(function() {
          var deferred = Q.defer();
          var waitMsec = interval - (Date.now() - lastCheck);

          setTimeout(function() {
            deferred.resolve(getTopicAndSend(consumerInstance));
          }, waitMsec > 0 ? waitMsec : 0)
          return deferred.promise;
        });
    }

    node.log('Creating consumer for topic: \'' + topic + '\'');

    try {
      instance
        .consume('nodered-' + topic + "-" + random(), 'nodered', { 'auto.offset.reset': 'largest' })
        .then(function(response) {
          return response[0];
        })
        .then(function(consumerInstance) {
          node.log("Consumer created...");
          node.status({fill:"green", shape:"ring", text:"Connected"});
          return getTopicAndSend(consumerInstance)
        })
        .fail(function(error) {
          node.status({fill:"red", shape:"ring", text: error.message});
          node.error('Error creating consumer', {error: error});
        });
    } catch(e) {
      node.error(e);
      node.status({fill:"red", shape:"ring", text:"Error while consuming"});
    }

    this.on('close', function() {
      node.loop = false;
    });
  }

  RED.nodes.registerType("messagehub in", MessageHubConsumer);
};
