var express = require('express');
var request = require('request');
const db = require('../helpers/db');
var format = require('pg-format');
var router = express.Router();
var se = require('../helpers/se');
var https = require('https');
const so_img = "https://cdn.sstatic.net/Sites/stackoverflow/company/img/logos/so/so-logo.png";
// App Dashboard > Dashboard > click the Show button in the App Secret field
const APP_SECRET = '6b8ac07a88dc1f07d13955f3610640ec';

// App Dashboard > Webhooks > Edit Subscription > copy whatever random value you decide to use in the Verify Token field
const VALIDATION_TOKEN = '0JcKvmRxcdKJp33kIRez';

// App Dashboard > Messenger > Settings > Token Generation > select your page > copy the token that appears
const PAGE_ACCESS_TOKEN = 'EAAFTU9DCBUQBALI2paPx88gLDM14MbWAlrXVKQIEXncAcoadQs9XUZCLGDxxbdopzx5Np7ngVZA8zCigQ7dAKxzJJPGnI6bQrIiSMqCPmlGufzFadcSbaH5TcptCiHWmTPWfnPDoMbBIjTdLDR4CPLfpUOg6r484RrtqYT9AZDZD';

// In an early version of this bot, the images were served from the local public/ folder.
// Using an ngrok.io domain to serve images is no longer supported by the Messenger Platform.
// Github Pages provides a simple image hosting solution (and it's free)
const IMG_BASE_PATH = 'https://rodnolan.github.io/posterific-static-images/';

// make sure that everything has been properly configured
if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN)) {
    console.error("Missing config values");
    process.exit(1);
}

/*
 * Verify that the request came from Facebook. You should expect a hash of
 * the App Secret from your App Dashboard to be present in the x-hub-signature
 * header field.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
    var signature = req.headers["x-hub-signature"];

    if (!signature) {
        // In DEV, log an error. In PROD, throw an error.
        console.error("Couldn't validate the signature.");
    } else {
        var elements = signature.split('=');
        var method = elements[0];
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', APP_SECRET)
            .update(buf)
            .digest('hex');

        console.log("received  %s", signatureHash);
        console.log("exepected %s", expectedHash);
        if (signatureHash != expectedHash) {
            throw new Error("Couldn't validate the request signature.");
        }
    }
}


/*
 * Verify that your validation token matches the one that is sent
 * from the App Dashboard during the webhook verification check.
 * Only then should you respond to the request with the
 * challenge that was sent.
 */
router.get('/fb', function (req, res) {
    if (req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === VALIDATION_TOKEN) {
        console.log("[app.get] Validating webhook");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        console.error("Failed validation. Validation token mismatch.");
        res.sendStatus(403);
    }
});


/*
 * All callbacks from Messenger are POST-ed. All events from all subscription
 * types are sent to the same webhook.
 *
 * Subscribe your app to your page to receive callbacks for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 */
router.post('/fb', function (req, res) {
    console.log("message received!");
    var data = req.body;
    // console.log(JSON.stringify(data));

    if (data.object == 'page') {
        // send back a 200 within 20 seconds to avoid timeouts

        // entries from multiple pages may be batched in one request
        data.entry.forEach(function (pageEntry) {

            // iterate over each messaging event for this page
            pageEntry.messaging.forEach(function (messagingEvent) {
                let propertyNames = Object.keys(messagingEvent);
                //console.log("[app.post] Webhook event props: ", propertyNames.join());

                if (messagingEvent.message) {
                    processMessageFromPage(messagingEvent);
                    res.sendStatus(200);
                } else if (messagingEvent.postback) {
                    // user replied by tapping a postback button
                    processPostbackMessage(messagingEvent);
                } else {
                    console.log("[app.post] not prepared to handle this message type.");
                }

            });
        });


    }
});

/*
 * called when a postback button is tapped
 * ie. buttons in structured messages and the Get Started button
 *
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function processPostbackMessage(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // the developer-defined field you set when you create postback buttons
    var payload = event.postback.payload;

    console.log("[processPostbackMessage] from user (%d) " +
        "on page (%d) " +
        "with payload ('%s') " +
        "at (%d)",
        senderID, recipientID, payload, timeOfPostback);

    respondToHelpRequest(senderID, payload);
}

/*
 * Called when a message is sent to your page.
 *
 */
function processMessageFromPage(event) {
    var senderID = event.sender.id;
    var pageID = event.recipient.id;
    var timeOfMessage = event.timestamp;
    var message = event.message;

    // console.log("[processMessageFromPage] user (%d) page (%d) timestamp (%d) and message (%s)", senderID, pageID, timeOfMessage, JSON.stringify(message));

    if (message.quick_reply) {
        console.log("[processMessageFromPage] quick_reply.payload (%s)",
            message.quick_reply.payload);
        handleQuickReplyResponse(event);
        return;
    }

    // the 'message' object format can vary depending on the kind of message that was received.
    // See: https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
    var messageText = message.text;
    if (messageText) {
        console.log("[processMessageFromPage]: %s", messageText);
        var lowerCaseMsg = messageText.toLowerCase();
        switch (lowerCaseMsg) {
            case 'help':
                // handle 'help' as a special case
                sendHelpOptionsAsQuickReplies(senderID);
                break;
            default:
                // otherwise, just echo it back to the sender
                processNLPMessage(senderID, event);
        }
    }
}

/*
 * Send a message with the four Quick Reply buttons
 *
 */
function sendHelpOptionsAsQuickReplies(recipientId) {
    console.log("[sendHelpOptionsAsQuickReplies] Sending help options menu");
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Select a feature to learn more.",
            quick_replies: [
                {
                    "content_type": "text",
                    "title": "Rotation",
                    "payload": "QR_ROTATION_1"
                },
                {
                    "content_type": "text",
                    "title": "Photo",
                    "payload": "QR_PHOTO_1"
                },
                {
                    "content_type": "text",
                    "title": "Caption",
                    "payload": "QR_CAPTION_1"
                },
                {
                    "content_type": "text",
                    "title": "Background",
                    "payload": "QR_BACKGROUND_1"
                }
            ]
        }
    };
    callSendAPI(messageData);
}

/*
 * user tapped a Quick Reply button; respond with the appropriate content
 *
 */
function handleQuickReplyResponse(event) {
    var senderID = event.sender.id;
    var pageID = event.recipient.id;
    var message = event.message;
    var payload = message.quick_reply.payload;

    console.log("[handleQuickReplyResponse] Handling quick reply response (%s) from sender (%d) to page (%d) with message (%s)",
        payload, senderID, pageID, JSON.stringify(message));

    respondToHelpRequest(senderID, payload);

}

/*
 * simplify switching between the two help response implementations
 */
function respondToHelpRequest(senderID, payload) {
    // set useGenericTemplates to false to send image attachments instead of generic templates
    var useGenericTemplates = true;
    var messageData = {};

    if (useGenericTemplates) {
        // respond to the sender's help request by presenting a carousel-style
        // set of screenshots of the application in action
        // each response includes all the content for the requested feature
        messageData = getGenericTemplates(senderID, payload);
    } else {
        // respond to the help request by presenting one image at a time
        messageData = getImageAttachments(senderID, payload);
    }

    callSendAPI(messageData);
}

/*
 * This response uses templateElements to present the user with a carousel
 * You send ALL of the content for the selected feature and they swipe
 * left and right to see it
 *
 */
function getGenericTemplates(recipientId, requestForHelpOnFeature,templateElements,sectionButtons) {
    console.log("[getGenericTemplates] handling help request for %s",
        requestForHelpOnFeature);
    // each button must be of type postback but title
    // and payload are variable depending on which
    // set of options you want to provide
    var addSectionButton = function (title, payload) {
        sectionButtons.push({
            type: 'postback',
            title: title,
            payload: payload
        });
    }

    // Since there are only four options in total, we will provide
    // buttons for each of the remaining three with each section.
    // This provides the user with maximum flexibility to navigate

    switch (requestForHelpOnFeature) {
        case 'QR_ROTATION_1':
            addSectionButton('Photo', 'QR_PHOTO_1');
            addSectionButton('Caption', 'QR_CAPTION_1');
            addSectionButton('Background', 'QR_BACKGROUND_1');

            templateElements.push(
                {
                    title: "Rotation",
                    subtitle: "portrait mode",
                    image_url: IMG_BASE_PATH + "01-rotate-landscape.png",
                    buttons: sectionButtons
                },
                {
                    title: "Rotation",
                    subtitle: "landscape mode",
                    image_url: IMG_BASE_PATH + "02-rotate-portrait.png",
                    buttons: sectionButtons
                }
            );
            break;
        case 'QR_PHOTO_1':
            addSectionButton('Rotation', 'QR_ROTATION_1');
            addSectionButton('Caption', 'QR_CAPTION_1');
            addSectionButton('Background', 'QR_BACKGROUND_1');

            templateElements.push(
                {
                    title: "Photo Picker",
                    subtitle: "click to start",
                    image_url: IMG_BASE_PATH + "03-photo-hover.png",
                    buttons: sectionButtons
                },
                {
                    title: "Photo Picker",
                    subtitle: "Downloads folder",
                    image_url: IMG_BASE_PATH + "04-photo-list.png",
                    buttons: sectionButtons
                },
                {
                    title: "Photo Picker",
                    subtitle: "photo selected",
                    image_url: IMG_BASE_PATH + "05-photo-selected.png",
                    buttons: sectionButtons
                }
            );
            break;
        case 'QR_CAPTION_1':
            addSectionButton('Rotation', 'QR_ROTATION_1');
            addSectionButton('Photo', 'QR_PHOTO_1');
            addSectionButton('Background', 'QR_BACKGROUND_1');

            templateElements.push(
                {
                    title: "Caption",
                    subtitle: "click to start",
                    image_url: IMG_BASE_PATH + "06-text-hover.png",
                    buttons: sectionButtons
                },
                {
                    title: "Caption",
                    subtitle: "enter text",
                    image_url: IMG_BASE_PATH + "07-text-mid-entry.png",
                    buttons: sectionButtons
                },
                {
                    title: "Caption",
                    subtitle: "click OK",
                    image_url: IMG_BASE_PATH + "08-text-entry-done.png",
                    buttons: sectionButtons
                },
                {
                    title: "Caption",
                    subtitle: "Caption done",
                    image_url: IMG_BASE_PATH + "09-text-complete.png",
                    buttons: sectionButtons
                }
            );
            break;
        case 'QR_BACKGROUND_1':
            addSectionButton('Rotation', 'QR_ROTATION_1');
            addSectionButton('Photo', 'QR_PHOTO_1');
            addSectionButton('Caption', 'QR_CAPTION_1');

            templateElements.push(
                {
                    title: "Background Color Picker",
                    subtitle: "click to start",
                    image_url: IMG_BASE_PATH + "10-background-picker-hover.png",
                    buttons: sectionButtons
                },
                {
                    title: "Background Color Picker",
                    subtitle: "click current color",
                    image_url: IMG_BASE_PATH + "11-background-picker-appears.png",
                    buttons: sectionButtons
                },
                {
                    title: "Background Color Picker",
                    subtitle: "select new color",
                    image_url: IMG_BASE_PATH + "12-background-picker-selection.png",
                    buttons: sectionButtons
                },
                {
                    title: "Background Color Picker",
                    subtitle: "click ok",
                    image_url: IMG_BASE_PATH + "13-background-picker-selection-made.png",
                    buttons: sectionButtons
                },
                {
                    title: "Background Color Picker",
                    subtitle: "color is applied",
                    image_url: IMG_BASE_PATH + "14-background-changed.png",
                    buttons: sectionButtons
                }
            );
            break;
    }

    if (templateElements.length < 2) {
        console.error("each template should have at least two elements");
    }

    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "list",
                    top_element_style: "compact",
                    elements: templateElements
                }
            }
        }
    };

    return messageData;
}

function createElementTemplate(type,title,subtitle,img,site){

    var btns = {};
        switch(type){
            case 'list':
                btns = { type: 'web_url',
                    url: site,
                    title: "Open",
                    messenger_extensions: 'TRUE',
                         webview_height_ratio: "COMPACT"
                };
            default:
               btns = {type: 'web_url',
                url: site,
                title: "Open"};
        }

    element = {
        title: title,
        subtitle: subtitle ,
        default_action: {type: 'web_url',
        url: site, messenger_extensions: 'FALSE',
            webview_height_ratio: "FULL"}
    };

    return element;
}
/*
 * This response uses image attachments to illustrate each step of each feature.
 * This is less flexible because you are limited in the number of options you can
 * provide for the user. This technique is best for cases where the content should
 * be consumed in a strict linear order.
 *
 */
function getImageAttachments(recipientId, helpRequestType) {
    var textToSend = '';
    var quickReplies = [
        {
            "content_type": "text",
            "title": "Restart",
            "payload": "QR_RESTART"
        }, // this option should always be present because it allows the user to start over
        {
            "content_type": "text",
            "title": "Continue",
            "payload": ""
        } // the Continue option only makes sense if there is more content to show
          // remove this option when you are at the end of a branch in the content tree
          // i.e.: when you are showing the last message for the selected feature
    ];

    // to send an image attachment in a message, just set the payload property of this attachment object
    // if the payload property is defined, this will be added to the message before it is sent
    var attachment = {
        "type": "image",
        "payload": ""
    };

    switch (helpRequestType) {
        case 'QR_RESTART' :
            sendHelpOptionsAsQuickReplies(recipientId);
            return;
            break;

        // the Rotation feature
        case 'QR_ROTATION_1' :
            textToSend = 'Click the Rotate button to toggle the poster\'s orientation between landscape and portrait mode.';
            quickReplies[1].payload = "QR_ROTATION_2";
            break;
        case 'QR_ROTATION_2' :
            // 1 of 2 (portrait, landscape)
            attachment.payload = {
                url: IMG_BASE_PATH + "01-rotate-landscape.png"
            }
            quickReplies[1].payload = "QR_ROTATION_3";
            break;
        case 'QR_ROTATION_3' :
            // 2 of 2 (portrait, landscape)
            attachment.payload = {
                url: IMG_BASE_PATH + "02-rotate-portrait.png"
            }
            quickReplies.pop();
            quickReplies[0].title = "Explore another feature";
            break;
        // the Rotation feature


        // the Photo feature
        case 'QR_PHOTO_1' :
            textToSend = 'Click the Photo button to select an image to use on your poster. We recommend visiting https://unsplash.com/random from your device to seed your Downloads folder with some images before you get started.';
            quickReplies[1].payload = "QR_PHOTO_2";
            break;
        case 'QR_PHOTO_2' :
            // 1 of 3 (placeholder image, Downloads folder, poster with image)
            attachment.payload = {
                url: IMG_BASE_PATH + "03-photo-hover.png"
            }
            quickReplies[1].payload = "QR_PHOTO_3";
            break;
        case 'QR_PHOTO_3' :
            // 2 of 3 (placeholder image, Downloads folder, poster with image)
            attachment.payload = {
                url: IMG_BASE_PATH + "04-photo-list.png"
            }
            quickReplies[1].payload = "QR_PHOTO_4";
            break;
        case 'QR_PHOTO_4' :
            // 3 of 3 (placeholder image, Downloads folder, poster with image)
            attachment.payload = {
                url: IMG_BASE_PATH + "05-photo-selected.png"
            }
            quickReplies.pop();
            quickReplies[0].title = "Explore another feature";
            break;
        // the Photo feature


        // the Caption feature
        case 'QR_CAPTION_1' :
            textToSend = 'Click the Text button to set the caption that appears at the bottom of the poster.';
            quickReplies[1].payload = "QR_CAPTION_2";
            break;
        case 'QR_CAPTION_2' :
            // 1 of 4 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "06-text-hover.png"
            }
            quickReplies[1].payload = "QR_CAPTION_3";
            break;
        case 'QR_CAPTION_3' :
            // 2 of 4: (hover, entering caption, mid-edit, poster with new caption
            attachment.payload = {
                url: IMG_BASE_PATH + "07-text-mid-entry.png"
            }
            quickReplies[1].payload = "QR_CAPTION_4";
            break;
        case 'QR_CAPTION_4' :
            // 3 of 4 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "08-text-entry-done.png"
            }
            quickReplies[1].payload = "QR_CAPTION_5";
            break;
        case 'QR_CAPTION_5' :
            // 4 of 4 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "09-text-complete.png"
            }
            quickReplies.pop();
            quickReplies[0].title = "Explore another feature";
            break;
        // the Caption feature


        // the Color Picker feature
        case 'QR_BACKGROUND_1' :
            textToSend = 'Click the Background button to select a background color for your poster.';
            quickReplies[1].payload = "QR_BACKGROUND_2";
            break;
        case 'QR_BACKGROUND_2' :
            // 1 of 5 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "10-background-picker-hover.png"
            }
            quickReplies[1].payload = "QR_BACKGROUND_3";
            break;
        case 'QR_BACKGROUND_3' :
            // 2 of 5 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "11-background-picker-appears.png"
            }
            quickReplies[1].payload = "QR_BACKGROUND_4";
            break;
        case 'QR_BACKGROUND_4' :
            // 3 of 5 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "12-background-picker-selection.png"
            }
            quickReplies[1].payload = "QR_BACKGROUND_5";
            break;
        case 'QR_BACKGROUND_5' :
            // 4 of 5 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "13-background-picker-selection-made.png"
            }
            quickReplies[1].payload = "QR_BACKGROUND_6";
            break;
        case 'QR_BACKGROUND_6' :
            // 5 of 5 (hover, entering caption, mid-edit, poster with new caption)
            attachment.payload = {
                url: IMG_BASE_PATH + "14-background-changed.png"
            }
            quickReplies.pop();
            quickReplies[0].title = "Explore another feature";
            break;
        // the Color Picker feature

        default :
            sendHelpOptionsAsQuickReplies(recipientId);
            return;

            break;
    }

    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: textToSend,
            quick_replies: quickReplies
        },
    };
    if (attachment.payload !== "") {
        messageData.message.attachment = attachment;
        // text can not be specified when you're sending an attachment
        delete messageData.message.text;
    }

    return messageData;
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText // utf-8, 640-character max
        }
    };
    console.log("[sendTextMessage] %s", JSON.stringify(messageData));
    callSendAPI(messageData);
}

/*
 * Call the Send API. If the call succeeds, the
 * message id is returned in the response.
 *
 */
function callSendAPI(messageData) {
    request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
        qs: {access_token: PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: messageData

    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var recipientId = body.recipient_id;
            var messageId = body.message_id;

            if (messageId) {
                console.log("[callSendAPI] message id %s sent to recipient %s",
                    messageId, recipientId);
            } else {
                console.log("[callSendAPI] called Send API for recipient %s",
                    recipientId);
            }
        } else {
            console.error("[callSendAPI] Send API call failed", response.statusCode, response.statusMessage, body.error);
        }
    });
}

var getDescriptionOfTool = function (toolnames, callback) {
    var tools = parseTools(toolnames);
    db.connect(function (err, client, done) {
        if (err) {
            console.log(err);
        }
        else {
            console.log("pool connected.");
            var myClient = client;
            var where = " where title IN (" + tools.join(",") + ")";
            var searchQuery = format('SELECT title, description from records' + where + ' ORDER BY title desc;');
            console.log("issuing query: " + searchQuery);
            var values = [];
            myClient.query(searchQuery, function (err, result) {
                if (err) {
                    console.log(err);
                    done(err);
                    return callback(err);
                } else {
                    console.log(result.rows.length);
                    results = result.rows;

                    results.forEach(function (row) {
                        var toolname = row.title;
                        values.push(
                            {
                                name: toolname,
                                description: row.description
                            });
                    });
                    callback(err, values);

                }

            });

        }
    });

};

var parseTools = function (tools) {
    names = [];

    for (var i = 0, len = tools.length; i < len; i++) {
        names.push("'" + tools[i].value + "'");
    }
    return names;
};


function loadEntities(){
        db.connect(function (err, client, done) {
            if (err) {
                console.log(err);
            }
            else {
                myClient = client;
                var searchQuery = format('SELECT distinct(title) from records ORDER BY title desc;');
                console.log("issuing query: " + searchQuery);
                myClient.query(searchQuery, function (err, result) {
                    if (err) {
                        console.log(err);
                    } else {
                        console.log(result.rows.length);
                        results = result.rows;
                        var values = [];
                        results.forEach(function (row) {
                            var toolname = row.title;
                            values.push(
                                {
                                    value: toolname,
                                    expressions: [toolname, toolname.toLowerCase()]
                                });
                        });
                        var entries = {doc: "Tools", values: values};
                        console.log(JSON.stringify(entries));
                        var postentreq = https.request({
                            host: 'api.wit.ai',
                            path: '/entities/tool?v=201703',
                            headers: {
                                "Authorization": "Bearer EMHECMMIQ3OL537ROQTJNMUCEAD4EC5J",
                                "Content-Type": "application/json"
                            },
                            method: 'PUT'
                        }, function (res) {
                            console.log(res.statusCode + " " + res.statusMessage);

                        });
                        postentreq.write(JSON.stringify(entries));
                        postentreq.on('error', function (e) {
                            // General error, i.e.
                            //  - ECONNRESET - server closed the socket unexpectedly
                            //  - ECONNREFUSED - server did not listen
                            //  - HPE_INVALID_VERSION
                            //  - HPE_INVALID_STATUS
                            //  - ... (other HPE_* codes) - server returned garbage
                            console.log(e);
                        });
                        postentreq.end();
                    }
                });
            }
        });
}

function processNLPMessage(senderId, event) {
    if (event.message.hasOwnProperty('nlp') && event.message.nlp.hasOwnProperty("entities")) {
        var nlp = event.message.nlp.entities;
        /**
         * Options:
         * nlp.intent =
         * nlp.search_query = [text not matching anything]
         * nlp.action = [build,install]
         * nlp.deliverable = [native app, web app, server, website]
         */
        console.log(nlp);

        if (nlp.hasOwnProperty("intent")) {
            //we have an intent for this message! yay.
            var intents = nlp.intent;
            var userintent = "";

            if (intents.length > 1) {
                intents.forEach(function (intent) {
                    var conf = intent.confidence;
                    if (conf > userintent.confidence) {
                        userintent = intent;
                    }
                });
            }
            else {
                userintent = intents[0];
            }

            switch (userintent.value.toLowerCase()) {
                case 'stack': // handle 'description' case
                    break;
                case 'description': // handle 'description' case
                    if(nlp.hasOwnProperty('tool')) {
                        getDescriptionOfTool(nlp.tool, function (err, result) {
                            if (err) {
                                console.log(err);
                            } else {
                                console.log(result);
                                sendResponseMessage(senderId, result);
                            }
                        });
                    }
                    else{
                        var q = event.message.text;
                        if(nlp.hasOwnProperty('wikipedia_search_query')){
                            q = nlp.wikipedia_search_query[0].value;
                        }

                        searchStackExchange(q,function(err,result){
                            if (err) {
                                console.log(err);
                            } else {
                                console.log(result);
                                sendSEMessage(senderId, result);
                            }
                        });
                        }
                    break;
                case 'how-to': // handle 'description' case
                    var q = event.message.text;
                       if(nlp.hasOwnProperty('wikipedia_search_query')){
                           q = nlp.wikipedia_search_query[0].value;
                       }

                        searchStackExchange(q,function(err,result){
                            if (err) {
                                console.log(err);
                            } else {
                                console.log(result);
                                sendSEMessage(senderId, result);
                            }
                        });
                    break;
                case 'users': // handle 'description' case
                    break;
                default:
                    // otherwise, just echo it back to the sender
                    sendTextMessage(senderId, "I'm having a hard time understanding. Can you try again?");
            }
        }

    } else {
        sendTextMessage(senderID, messageText);
    }
}

function searchStackExchange(query,callback){

    //try to search stack exchange for answers.

    se.search(query,function(err,results){
        if(err){console.log(err);}
        else{
            //process results
            callback(err,results);
        }
    });

}
/*
 * Send a text message using the Send API.
 *
 */
function sendResponseMessage(recipientId, responses) {
    responses.forEach(function (response) {
        if (response.description.length >= 640){
            response.description = response.description.substring(0,620) + "...";
        }
        var body = response.name + " : " + response.description;
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                text: body // utf-8, 640-character max
            }
        };
        console.log("[sendTextMessage] %s", JSON.stringify(messageData));
        callSendAPI(messageData);
    });

}

function sendSEMessage(recipientId,responses){
    var messageData = {};
    var entries = [];
    var buttons = [];
    responses.forEach(function (response) {
        var element = createElementTemplate("list",response.title,response.tags.join(''),so_img,response.link);
        entries.push(element);
        console.log("[sendTextMessage] %s", JSON.stringify(messageData));
    });
    messageData = getGenericTemplates(recipientId,false,entries,buttons);
    messageData.message.attachment.payload.buttons = [];
    messageData.message.attachment.payload.buttons = [
        {
            "title": "View More",
            "type": "postback",
            "payload": "payload"
        }];
    callSendAPI(messageData);
};
// loadEntities();
module.exports = router;


