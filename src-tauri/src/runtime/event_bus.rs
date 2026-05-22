use std::sync::Arc;
use parking_lot::RwLock;
use serde_json::Value;

/// A trait for receiving events emitted by the runtime.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: &Value);
}

/// A bus that maintains multiple registered event sinks and broadcasts events to all of them.
pub struct EventBus {
    sinks: RwLock<Vec<Arc<dyn EventSink>>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            sinks: RwLock::new(Vec::new()),
        }
    }

    /// Register a new event sink.
    pub fn register(&self, sink: Arc<dyn EventSink>) {
        self.sinks.write().push(sink);
    }

    /// Broadcast an event to all registered sinks.
    pub fn broadcast(&self, event: &str, payload: &Value) {
        let sinks = self.sinks.read();
        for sink in sinks.iter() {
            sink.emit(event, payload);
        }
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

/// A wrapper to easily convert any matching closure/function into an EventSink.
pub struct ClosureEventSink<F> {
    func: F,
}

impl<F> ClosureEventSink<F>
where
    F: Fn(&str, &Value) + Send + Sync,
{
    pub fn new(func: F) -> Self {
        Self { func }
    }
}

impl<F> EventSink for ClosureEventSink<F>
where
    F: Fn(&str, &Value) + Send + Sync,
{
    fn emit(&self, event: &str, payload: &Value) {
        (self.func)(event, payload);
    }
}
