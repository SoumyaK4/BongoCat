use input::{
    event::{
        keyboard::{KeyState, KeyboardEventTrait},
        pointer::{ButtonState, PointerEvent},
    },
    Event, Libinput, LibinputInterface,
};
use nix::{
    libc::{O_RDONLY, O_RDWR, O_WRONLY},
    poll::{poll, PollFd, PollFlags, PollTimeout},
};
use std::{
    fs::{File, OpenOptions}, os::{fd::{AsFd, OwnedFd}, unix::prelude::OpenOptionsExt}, path::Path
};

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Runtime, command};

use crate::core::{device::{DeviceEvent, DeviceEventKind}, setup::key_from_code};

static IS_LISTENING: AtomicBool = AtomicBool::new(false);

pub struct Interface;

impl LibinputInterface for Interface {
    fn open_restricted(&mut self, path: &Path, flags: i32) -> Result<OwnedFd, i32> {
        OpenOptions::new()
            .custom_flags(flags)
            .read((flags & O_RDONLY != 0) | (flags & O_RDWR != 0))
            .write((flags & O_WRONLY != 0) | (flags & O_RDWR != 0))
            .open(path)
            .map(|file| file.into())
            .map_err(|err| err.raw_os_error().unwrap())
    }

    #[allow(unused_must_use)]
    fn close_restricted(&mut self, fd: OwnedFd) {
        let _ = File::from(fd);
    }
}

fn build_device_event(event: &Event) -> Option<DeviceEvent> {
    match event {
        Event::Keyboard(ev) => {
            let key_code = ev.key();
            let key_name = match key_from_code(key_code) {
                Some(name) => name.to_string(),
                None => format!("Unknown({})", key_code),
            };
            match ev.key_state() {
                KeyState::Pressed => Some(DeviceEvent {
                    kind: DeviceEventKind::KeyboardPress,
                    value: json!(key_name), 
                }),
                KeyState::Released => Some(DeviceEvent{
                    kind: DeviceEventKind::KeyboardRelease,
                    value: json!(key_name),
                }) 
            }
        },
        Event::Pointer(ev) => {
            match ev {
                PointerEvent::Button(e) => {
                    let btn_code = e.button();
                    let btn_name = match btn_code {
                        0x110 => String::from("Left"),
                        0x111 => String::from("Right"),
                        0x112 => String::from("Middle"),
                        _ => format!("Unknown({})", btn_code),
                    };
                    match e.button_state() {
                        ButtonState::Pressed => Some(DeviceEvent {
                            kind: DeviceEventKind::MousePress,
                            value: json!(btn_name), 
                        }),
                        ButtonState::Released => Some(DeviceEvent {
                            kind: DeviceEventKind::MouseRelease,
                            value: json!(btn_name), 
                        })
                    }
                },
                PointerEvent::Motion(e) => {
                    Some(DeviceEvent {
                        kind: DeviceEventKind::MouseMove,
                        value: json!({
                            "dx": e.dx(),
                            "dy": e.dy(),
                        }),
                    })
                },
                PointerEvent::MotionAbsolute(e) => {
                    Some(DeviceEvent {
                        kind: DeviceEventKind::MouseMove,
                        value: json!({
                            "x": e.absolute_x(),
                            "y": e.absolute_y(),
                        }),
                    })
                },
                _ => None,
            }
        },
        _ => None,
    }
}


#[command]
pub async fn start_device_listening<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    if IS_LISTENING.load(Ordering::SeqCst) {
        return Ok(());
    }

    let (tx, rx) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        let mut input = Libinput::new_with_udev(Interface);
        if let Err(err) = input.udev_assign_seat("seat0") {
            let _ = tx.send(Err(format!("Failed to assign seat: {:?}. Make sure you are in the 'input' group.", err)));
            return;
        }

        let _ = tx.send(Ok(()));
        IS_LISTENING.store(true, Ordering::SeqCst);

        while IS_LISTENING.load(Ordering::SeqCst) {
            let n = {
                let mut pollfds = [PollFd::new(input.as_fd(), PollFlags::POLLIN)];
                poll(&mut pollfds, PollTimeout::from(100u16))
            };

            match n {
                Ok(n) if n > 0 => {
                    if let Err(err) = input.dispatch() {
                         eprintln!("Libinput dispatch error: {:?}", err);
                         break;
                    }
                    for event in &mut input {
                        if let Some(e) = build_device_event(&event) {
                            let _ = app_handle.emit("device-changed", e);
                        }
                    }
                }
                Ok(_) => {}, // Timeout or no events
                Err(err) => {
                    if err != nix::Error::EINTR {
                        eprintln!("Poll error: {:?}", err);
                        break;
                    }
                }
            }
        }
        IS_LISTENING.store(false, Ordering::SeqCst);
    });

    rx.recv().map_err(|_| "Failed to start listening thread".to_string())?
}
