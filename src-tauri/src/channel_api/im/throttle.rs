use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use crate::channel_api::im::plugin::{ImPlugin, OutgoingMessage, ActionButton};

pub struct StreamThrottle {
    tx: mpsc::Sender<StreamUpdate>,
}

enum StreamUpdate {
    Append(String),
    Finish(Option<Vec<ActionButton>>),
}

impl StreamThrottle {
    pub fn new(
        chat_id: String,
        initial_msg_id: String,
        plugin: Arc<dyn ImPlugin>,
        interval: Duration,
    ) -> Self {
        let (tx, mut rx) = mpsc::channel::<StreamUpdate>(100);

        tokio::spawn(async move {
            let mut current_text = String::new();
            let msg_id = initial_msg_id;
            let mut pending_update = false;

            let mut interval_timer = tokio::time::interval(interval);
            interval_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            loop {
                tokio::select! {
                    update = rx.recv() => {
                        match update {
                            Some(StreamUpdate::Append(text)) => {
                                current_text = text;
                                pending_update = true;
                            }
                            Some(StreamUpdate::Finish(buttons)) => {
                                // Final update: send immediately
                                let out_msg = OutgoingMessage {
                                    text: current_text.clone(),
                                    buttons,
                                    is_streaming_update: false,
                                };
                                let _ = plugin.edit_message(&chat_id, &msg_id, out_msg).await;
                                break;
                            }
                            None => {
                                break;
                            }
                        }
                    }
                    _ = interval_timer.tick() => {
                        if pending_update {
                            let out_msg = OutgoingMessage {
                                text: current_text.clone(),
                                buttons: None,
                                is_streaming_update: true,
                            };
                            let _ = plugin.edit_message(&chat_id, &msg_id, out_msg).await;
                            pending_update = false;
                        }
                    }
                }
            }
        });

        Self { tx }
    }

    pub async fn feed(&self, text: String) {
        let _ = self.tx.send(StreamUpdate::Append(text)).await;
    }

    pub async fn finish(&self, buttons: Option<Vec<ActionButton>>) {
        let _ = self.tx.send(StreamUpdate::Finish(buttons)).await;
    }
}
