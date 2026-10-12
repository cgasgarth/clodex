use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    ptr, slice,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

const TRIGGER: &str = "[CPA_NATIVE_COMPACTION_TRIGGER]";
const MARKER_START: &str = "[CPA_NATIVE_COMPACTION:";
const COMPACT_START: &str = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";
const COMPACT_END: &str = "REMINDER: Do NOT call any tools. Respond with plain text only";

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Intercept {
    source_format: String,
    model: String,
    stream: bool,
    body: String,
    headers: Value,
    metadata: Value,
    #[serde(rename = "host_callback_id")]
    callback: String,
}

#[derive(Serialize, Deserialize)]
struct Checkpoint {
    model: String,
    auth_id: String,
    output: Vec<Value>,
}

fn is_gpt(model: &str) -> bool {
    model.starts_with("gpt-") || model.starts_with("codex-")
}

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// A marker is a durable reference, never the model's actual context.
fn marker(text: &str) -> Result<Option<(String, usize)>, String> {
    let Some(start) = text.rfind(MARKER_START) else {
        return Ok(None);
    };
    let id_start = start + MARKER_START.len();
    let end = text[id_start..]
        .find(']')
        .ok_or("Incomplete compaction checkpoint marker")?
        + id_start;
    let id = &text[id_start..end];
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid compaction checkpoint ID".into());
    }
    Ok(Some((id.into(), end + 1)))
}

fn checkpoint_dir() -> Result<PathBuf, String> {
    Ok(
        PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unset")?)
            .join(".cli-proxy-api/native-compaction"),
    )
}

fn load(id: &str) -> Result<Checkpoint, String> {
    let bytes = fs::read(checkpoint_dir()?.join(format!("{id}.json")))
        .map_err(|e| format!("Cannot load compaction checkpoint {id}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn save(checkpoint: &Checkpoint) -> Result<String, String> {
    let dir = checkpoint_dir()?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dir.join(format!("{id}.json")))
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(checkpoint).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(format!("{MARKER_START}{id}]"))
}

fn latest_marker(items: &[Value]) -> Result<Option<(usize, String, usize)>, String> {
    for (i, item) in items.iter().enumerate().rev() {
        if matches!(item["role"].as_str(), Some("user" | "assistant")) {
            if let Some((id, end)) = marker(&text(&item["content"]))? {
                return Ok(Some((i, id, end)));
            }
        }
    }
    Ok(None)
}

fn validate(body: &Value, model: &str, auth: &str) -> Result<(), String> {
    let Some(items) = body["messages"].as_array() else {
        return Ok(());
    };
    let Some((_, id, _)) = latest_marker(items)? else {
        return Ok(());
    };
    let checkpoint = load(&id)?;
    if checkpoint.model != model || checkpoint.auth_id != auth {
        return Err("This compacted chat requires its original GPT model and credential. Restore that selection before continuing.".into());
    }
    Ok(())
}

fn restore(body: &mut Value) -> Result<bool, String> {
    let Some(items) = body["input"].as_array() else {
        return Ok(false);
    };
    let Some((index, id, end)) = latest_marker(items)? else {
        return Ok(false);
    };
    let checkpoint = load(&id)?;
    // Keep today's system instructions. The canonical compact output is unchanged.
    let mut input: Vec<Value> = items[..index]
        .iter()
        .filter(|item| matches!(item["role"].as_str(), Some("system" | "developer")))
        .filter(|item| !checkpoint.output.contains(item))
        .cloned()
        .collect();
    input.extend(checkpoint.output);
    let suffix = text(&items[index]["content"])[end..].trim().to_owned();
    if !suffix.is_empty() {
        input.push(json!({"role":"user", "content":[{"type":"input_text", "text":suffix}]}));
    }
    input.extend_from_slice(&items[index + 1..]);
    body["input"] = json!(input);
    body.as_object_mut()
        .ok_or("Invalid request object")?
        .remove("previous_response_id");
    Ok(true)
}

fn normalize(raw: &[u8]) -> Result<Value, String> {
    let req: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    if req["FromFormat"] != "claude"
        || !matches!(req["ToFormat"].as_str(), Some("codex" | "openai-response"))
        || !is_gpt(req["Model"].as_str().unwrap_or_default())
    {
        return Ok(json!({}));
    }
    let bytes = STANDARD
        .decode(req["Body"].as_str().ok_or("Missing body")?)
        .map_err(|e| e.to_string())?;
    let mut body: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut changed = restore(&mut body)?;
    if let Some(items) = body["input"].as_array_mut() {
        if items
            .last()
            .is_some_and(|item| item["role"] == "user" && text(&item["content"]) == TRIGGER)
        {
            items.pop();
            items.push(json!({"type":"compaction_trigger"}));
            changed = true;
        }
    }
    if changed {
        Ok(json!({"Body":STANDARD.encode(serde_json::to_vec(&body).map_err(|e| e.to_string())?)}))
    } else {
        Ok(json!({}))
    }
}

fn terminate(status: u16, content_type: &str, bytes: Vec<u8>) -> Value {
    json!({"Terminate":true, "StatusCode":status,
        "ResponseHeaders":{"Content-Type":[content_type],"Cache-Control":["no-store"]},
        "ResponseBody":STANDARD.encode(bytes)})
}

fn reject(error: String) -> Value {
    reject_status(502, error)
}

fn reject_status(status: u16, error: String) -> Value {
    terminate(
        status,
        "application/json",
        serde_json::to_vec(&json!({"type":"error",
        "error":{"type":"native_compaction_error","message":error}}))
        .expect("error JSON"),
    )
}

fn claude_response(model: &str, marker: &str, stream: bool) -> Result<Value, String> {
    let message = json!({"id":format!("msg_{}",uuid::Uuid::new_v4().simple()),"type":"message",
        "role":"assistant","model":model,"content":[{"type":"text","text":marker}],
        "stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}});
    if !stream {
        return Ok(terminate(
            200,
            "application/json",
            serde_json::to_vec(&message).map_err(|e| e.to_string())?,
        ));
    }
    let mut start = message.clone();
    start["content"] = json!([]);
    start["stop_reason"] = Value::Null;
    let events = [
        (
            "message_start",
            json!({"type":"message_start","message":start}),
        ),
        (
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        ),
        (
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":marker}}),
        ),
        (
            "content_block_stop",
            json!({"type":"content_block_stop","index":0}),
        ),
        (
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}),
        ),
        ("message_stop", json!({"type":"message_stop"})),
    ];
    let mut bytes = String::new();
    for (event, data) in events {
        bytes.push_str(&format!("event: {event}\ndata: {data}\n\n"));
    }
    Ok(terminate(200, "text/event-stream", bytes.into_bytes()))
}

fn intercept(raw: &[u8]) -> Result<Value, String> {
    let req: Intercept = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let claude = req.source_format == "claude";
    let standalone = req.source_format == "openai-response"
        && req.metadata["request_path"]
            .as_str()
            .is_some_and(|p| p.ends_with("/responses/compact"));
    if !claude && !standalone {
        return Ok(json!({}));
    }
    let bytes = STANDARD.decode(&req.body).map_err(|e| e.to_string())?;
    let mut body: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let auth = req.metadata["selected_auth_id"]
        .as_str()
        .ok_or("Selected credential ID missing")?;
    if claude {
        if let Err(error) = validate(&body, &req.model, auth) {
            return Ok(reject_status(400, error));
        }
    }
    if !is_gpt(&req.model) {
        return Ok(json!({}));
    }
    let manual = claude
        && body.get("diagnostics").is_none()
        && body["messages"]
            .as_array()
            .and_then(|items| items.last())
            .is_some_and(|last| {
                last["role"] == "user" && {
                    let prompt = text(&last["content"]);
                    prompt.contains(COMPACT_START) && prompt.contains(COMPACT_END)
                }
            });
    if !standalone && !manual {
        return Ok(json!({}));
    }
    if manual {
        let messages = body["messages"].as_array_mut().ok_or("Missing messages")?;
        messages.pop();
        messages.push(json!({"role":"user","content":TRIGGER}));
    } else {
        if let Some(text) = body["input"].as_str() {
            body["input"] = json!([{"role":"user","content":text}]);
        }
        let input = body["input"]
            .as_array_mut()
            .ok_or("Compaction requires an input array")?;
        if input
            .last()
            .is_some_and(|x| x["type"] == "compaction_trigger")
        {
            input.pop();
        }
        input.push(json!({"type":"compaction_trigger"}));
    }
    body["stream"] = json!(false);
    body["store"] = json!(false);
    let obj = body.as_object_mut().ok_or("Invalid compact request")?;
    obj.remove("previous_response_id");
    obj.remove("context_management");
    obj.remove("tool_choice");
    let result = host_call(
        "host.model.execute",
        json!({
            "entry_protocol":req.source_format,"exit_protocol":"openai-response","model":req.model,
            "stream":false,"body":STANDARD.encode(serde_json::to_vec(&body).map_err(|e|e.to_string())?),
            "headers":req.headers,"path":"/v1/responses","auth_id":auth,"host_callback_id":req.callback
        }),
    )?;
    let output_bytes = STANDARD
        .decode(
            result["body"]
                .as_str()
                .ok_or("Missing compact response body")?,
        )
        .map_err(|e| e.to_string())?;
    let response: Value = serde_json::from_slice(&output_bytes).map_err(|e| e.to_string())?;
    let output = response["output"]
        .as_array()
        .ok_or("Native compaction returned no output")?;
    if !output
        .iter()
        .any(|item| item["type"] == "compaction" && item["encrypted_content"].is_string())
    {
        return Err(
            "OpenAI returned no encrypted compaction item; the chat was not compacted".into(),
        );
    }
    eprintln!(
        "native-compaction: completed model={} input_tokens={} output_tokens={}",
        req.model, response["usage"]["input_tokens"], response["usage"]["output_tokens"]
    );
    if manual {
        let marker = save(&Checkpoint {
            model: req.model.clone(),
            auth_id: auth.into(),
            output: output.clone(),
        })?;
        claude_response(&req.model, &marker, req.stream)
    } else {
        let id = output
            .iter()
            .find(|x| x["type"] == "compaction")
            .and_then(|x| x["id"].as_str())
            .ok_or("Missing compaction ID")?;
        let compact = json!({"id":id,"object":"response.compaction","created_at":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_secs(),"output":output,"usage":response["usage"]});
        Ok(terminate(
            200,
            "application/json",
            serde_json::to_vec(&compact).map_err(|e| e.to_string())?,
        ))
    }
}

fn dispatch(method: &str, raw: &[u8]) -> Result<Value, String> {
    match method {
        "plugin.register" | "plugin.reconfigure" => Ok(json!({"schema_version":1,
            "metadata":{"Name":"Native GPT Compaction","Version":env!("CARGO_PKG_VERSION"),"Author":"cgasgarth","GitHubRepository":"https://github.com/cgasgarth/codex"},
            "capabilities":{"request_interceptor":true,"request_normalizer":true}})),
        "request.intercept_before" => Ok(json!({})),
        "request.intercept_after" => Ok(intercept(raw).unwrap_or_else(reject)),
        "request.normalize" => normalize(raw),
        _ => Err(format!("Unsupported method: {method}")),
    }
}

// Published CLIProxyAPI C ABI v1. No CPA runtime version constraint.
#[repr(C)]
pub struct Buffer {
    ptr: *mut u8,
    len: usize,
}
type HostCall =
    unsafe extern "C" fn(*mut c_void, *const c_char, *const u8, usize, *mut Buffer) -> i32;
type Free = unsafe extern "C" fn(*mut c_void, usize);
#[repr(C)]
pub struct HostApi {
    abi_version: u32,
    host_ctx: *mut c_void,
    call: Option<HostCall>,
    free_buffer: Option<Free>,
}
#[repr(C)]
pub struct PluginApi {
    abi_version: u32,
    call: Option<unsafe extern "C" fn(*const c_char, *const u8, usize, *mut Buffer) -> i32>,
    free_buffer: Option<Free>,
    shutdown: Option<unsafe extern "C" fn()>,
}
struct Host {
    context: usize,
    call: HostCall,
    free: Free,
}
static HOST: OnceLock<Host> = OnceLock::new();

fn host_call(method: &str, request: Value) -> Result<Value, String> {
    let host = HOST.get().ok_or("Host API unavailable")?;
    let method = CString::new(method).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let mut out = Buffer {
        ptr: ptr::null_mut(),
        len: 0,
    };
    unsafe {
        (host.call)(
            host.context as *mut c_void,
            method.as_ptr(),
            bytes.as_ptr(),
            bytes.len(),
            &mut out,
        );
        if out.ptr.is_null() {
            return Err("Host callback returned no response".into());
        }
        let response: Result<Value, _> =
            serde_json::from_slice(slice::from_raw_parts(out.ptr, out.len));
        (host.free)(out.ptr.cast(), out.len);
        let response = response.map_err(|e| e.to_string())?;
        if response["ok"] != true {
            return Err(response["error"]["message"]
                .as_str()
                .unwrap_or("Host execution failed")
                .into());
        }
        Ok(response["result"].clone())
    }
}

#[no_mangle]
pub unsafe extern "C" fn cliproxy_plugin_init(host: *const HostApi, plugin: *mut PluginApi) -> i32 {
    if host.is_null() || plugin.is_null() || (*host).abi_version != 1 {
        return 1;
    }
    let (Some(call_host), Some(free_host)) = ((*host).call, (*host).free_buffer) else {
        return 1;
    };
    if HOST
        .set(Host {
            context: (*host).host_ctx as usize,
            call: call_host,
            free: free_host,
        })
        .is_err()
    {
        return 1;
    }
    *plugin = PluginApi {
        abi_version: 1,
        call: Some(call),
        free_buffer: Some(free_buffer),
        shutdown: Some(shutdown),
    };
    0
}

unsafe extern "C" fn call(
    method: *const c_char,
    request: *const u8,
    len: usize,
    out: *mut Buffer,
) -> i32 {
    if out.is_null() {
        return 1;
    }
    *out = Buffer {
        ptr: ptr::null_mut(),
        len: 0,
    };
    if method.is_null() || request.is_null() {
        return 1;
    }
    let result = std::panic::catch_unwind(|| {
        CStr::from_ptr(method)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(|method| dispatch(method, slice::from_raw_parts(request, len)))
    })
    .unwrap_or_else(|_| Err("Plugin panic".into()));
    let response = match result {
        Ok(value) => json!({"ok":true,"result":value}),
        Err(message) => {
            json!({"ok":false,"error":{"code":"native_compaction_error","message":message}})
        }
    };
    let bytes = serde_json::to_vec(&response)
        .expect("JSON envelope")
        .into_boxed_slice();
    *out = Buffer {
        len: bytes.len(),
        ptr: Box::into_raw(bytes) as *mut u8,
    };
    0
}
unsafe extern "C" fn free_buffer(buffer: *mut c_void, len: usize) {
    if !buffer.is_null() {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
            buffer as *mut u8,
            len,
        )));
    }
}
unsafe extern "C" fn shutdown() {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_checkpoint_ids() {
        assert!(marker("[CPA_NATIVE_COMPACTION:../../auth]").is_err());
        assert!(marker("[CPA_NATIVE_COMPACTION:broken").is_err());
    }
    #[test]
    fn emits_complete_claude_stream() {
        let response = claude_response("gpt-6.1-sol", "checkpoint", true).unwrap();
        let bytes = STANDARD
            .decode(response["ResponseBody"].as_str().unwrap())
            .unwrap();
        let stream = String::from_utf8(bytes).unwrap();
        assert!(stream.starts_with("event: message_start\n"));
        assert!(stream.contains("\"text\":\"checkpoint\""));
        assert!(stream.ends_with("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
    }

    #[test]
    fn converts_trigger_after_codex_translation() {
        let body = json!({"model":"gpt-6.1-sol","input":[{"role":"user","content":[{"type":"input_text","text":TRIGGER}]}]});
        let request = json!({"FromFormat":"claude","ToFormat":"codex","Model":"gpt-6.1-sol","Body":STANDARD.encode(serde_json::to_vec(&body).unwrap())});
        let out = normalize(&serde_json::to_vec(&request).unwrap()).unwrap();
        let body: Value =
            serde_json::from_slice(&STANDARD.decode(out["Body"].as_str().unwrap()).unwrap())
                .unwrap();
        assert_eq!(body["input"], json!([{"type":"compaction_trigger"}]));
    }
}
