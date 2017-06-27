/**
 * Created by fwang1 on 3/25/15.
 */

var MessageHub = require('message-hub-rest');
var Q = require('q');

function createServices(config) {
  return {
    "messagehub": [
      {
        "credentials": {
          "api_key":  config.apikey,
          "kafka_rest_url": config.kafkaresturl
        }
      }
    ]
  }
}

module.exports = function(RED) {
    var vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    var services = vcap["messagehub"] || [];

    // make these names available to the node configuration
    RED.httpAdmin.get('/message-hub/vcap', function(req, res) {
      res.json(services);
    });

    RED.httpAdmin.get('/message-hub/service/:serviceSelectedVal/topics', function(req, res) {
      var serviceSelectedVal = decodeURIComponent(req.params.serviceSelectedVal),
        selectedService = services.find(function(service) {
            return service.name == serviceSelectedVal;
        });

      if (!selectedService)
        return res.json([]);

      var instance = new MessageHub({
        messagehub: [selectedService]
      });

      instance.topics.get()
        .then(function(response) {
          res.json(response);
        })
        .fail(function(error) {
          res.json(error)
        });
    });

  /*
   *   MessageHub Producer
   */
  function MessageHubProducer(config) {
    RED.nodes.createNode(this, config);

    var node = this;
    var services = createServices(config);

    var instance = new MessageHub(services);
    var topic = config.topic;

    try {
      this.on("input", function(msg) {
        var payloads = [];

        node.log(msg.payload);
        payloads.push(msg.payload);

        var list = new MessageHub.MessageList(payloads);

        instance.produce(topic, list.messages)
        .then(function(data) {
          node.debug("Message sent");
          node.debug(data);
        })
        .fail(function(error) {
          node.error(error);
        });
      });
    }
    catch(e) {
      node.error(e);
    }
  }

  RED.nodes.registerType("messagehub out", MessageHubProducer);

  /*
   * Message Hub Consumer
   */
  function MessageHubConsumer(config) {
    RED.nodes.createNode(this,config);

    var node = this;
    var interval = parseInt(config.interval) || 2000;
    var services = createServices(config);

    var instance = new MessageHub(services);
    var topic = config.topic;

    function random() {
      return Math.floor((Math.random() * 100) + 1);
    }

    function getTopicAndSend(consumerInstance) {
      var lastCheck = Date.now();
      return consumerInstance
        .get(topic)
        .then(function(data) {
          for (var i=0; i < data.length; i++) {
            node.send({payload: data[i]});
          }
        })
        .fail(function(err) {
          node.error(err);
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

    instance
      .consume('nodered-' + topic + "-" + random(), 'nodered', { 'auto.offset.reset': 'largest' })
      .then(function(response) {
        return response[0];
      })
      .then(function(consumerInstance) {
        node.log("Consumer created...");
        return getTopicAndSend(consumerInstance)
      })
      .fail(function(error) {
        node.error(error);
      });
  }

  RED.nodes.registerType("messagehub in", MessageHubConsumer);
};
