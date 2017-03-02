var async = require('async');

var INSTANCE_RETRY_MS = 3000,
  POLL_INTERVAL_MS = 2000;

/**
 * Created by fwang1 on 3/25/15.
 */
module.exports = function(RED) {

  var instanceName;
  try {
    // If we're on Bluemix, use the unique app ID as instance name
    var vcapApplication = JSON.parse(process.env.VCAP_APPLICATION);
    instanceName = vcapApplication.application_id + "_" + (vcapApplication.instance_index ? vcapApplication.instance_index : "0");
  } catch (e) {
    // Otherwise use a random string
    instanceName = "nodered-" + Math.floor((Math.random() * 100) + 1) + "-" + Date.now();
  }
  console.log("Using " + instanceName + " as instance name");

  /*
   *   MessageHub Producer
   */
  function MessageHubProducer(config) {
    var node = this,
      MessageHub = require('message-hub-rest'),
      apikey = config.apikey,
      kafka_rest_url = config.kafkaresturl,
      services = {
        "messagehub": [{
          "credentials": {
            "api_key": apikey,
            "kafka_rest_url": kafka_rest_url
          }
        }]
      },
      topic = config.topic;

    RED.nodes.createNode(node, config);

    node.on("input", function(msg) {
      var instance = new MessageHub(services),
        payloads = [];

      payloads.push(msg.payload);

      var list = new MessageHub.MessageList(payloads);

      instance.produce(topic, list.messages)
        .then(function(data) {
          node.log("Message successfully published on messsage hub");
          console.log(data);
        })
        .fail(function(error) {
          node.error("Unable to publish message on message hub (" + error.message + ")");
        });
    });
  }
  RED.nodes.registerType("messagehub out", MessageHubProducer);

  /*
   * Message Hub Consumer
   */
  function createConsumerInstance(messageHub, topic, cb) {
    if (!messageHub) {
      cb(new Error("Message Hub client is null"));
      return;
    }
    messageHub.consume('nodered-' + instanceName, 'nodered', {
        'auto.offset.reset': 'largest'
      })
      .then(function(response) {
        cb(null, response[0]);
        return;
      })
      .fail(function(err) {
        cb(err);
        return;
      });
  }

  function poll(consumerInstance, topic, cb) {
    if (!consumerInstance) {
      cb(new Error("Consumer instance is null"));
      return;
    }
    consumerInstance.get(topic)
      .then(function(data) {
        cb(null, data);
      })
      .fail(function(err) {
        cb(err);
      });
  }

  function MessageHubConsumer(config) {
    RED.nodes.createNode(this, config);

    var node = this,
      MessageHub = require('message-hub-rest'),
      apikey = config.apikey,
      kafka_rest_url = config.kafkaresturl,
      services = {
        "messagehub": [{
          "credentials": {
            "api_key": apikey,
            "kafka_rest_url": kafka_rest_url
          }
        }]
      },
      messageHub = new MessageHub(services),
      topic = config.topic;

    var currentErr;

    async.forever(function(next) {
      createConsumerInstance(messageHub, topic, function(err, consumerInstance) {
        if (err) { // We keep on retrying in case of error - it could be just that Message Hub is not responding
          if (!currentErr) {
            node.error("Message hub is in error: " + err.message);
          }
          currentErr = err;
          setTimeout(next, INSTANCE_RETRY_MS);
        } else {
          if (currentErr) {
            node.log("Message hub is back to work");
            currentErr = null;
          }
          async.forever(function(_next) {
            poll(consumerInstance, topic, function(err, data) {
              if (err) {
                _next(err);
              } else {
                if (currentErr) {
                  node.log("Message hub is back to work");
                } else if (currentErr === undefined) {
                  node.log("Message hub is connected for topic " + topic);
                }
                currentErr = null;
                for (var i = 0; i < data.length; i++) {
                  node.send({
                    payload: data[i]
                  });
                }
                setTimeout(_next, POLL_INTERVAL_MS);
              }
            });
          }, function(err) {
            if (!currentErr) {
              node.error("Message hub is in error: " + err.message);
            }
            currentErr = err;
            next();
          });
        }
      });
    });
  }

  RED.nodes.registerType("messagehub in", MessageHubConsumer);
};