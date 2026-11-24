// Read the notifications on the Mac and on the phone (Mac only if no phone is connected), newest first, without acting on any. args: serial (optional), phoneOnly (true: phone only, and fail if none is connected)
let phone = [];
let note = null;
try {
  phone = await ui.device(args.serial).notifications({ emit: false });
} catch (error) {
  // Only the "no phone" case falls back to the Mac; anything else, or phoneOnly, fails.
  if (args.phoneOnly || !/^No Android device is connected/.test(String(error?.message))) throw error;
  note = "Note: no phone is connected, so only the Mac's notifications are listed.";
}
const mac = args.phoneOnly ? [] : await ui.notifications();
const lines = [
  ...mac.map((n) => `Mac    ${n.app}: ${[n.title, n.body].filter(Boolean).join(" — ")}`),
  ...phone.map((n) => `Phone  ${n.app}: ${[n.title, n.text].filter(Boolean).join(" — ")}`),
];
if (note) lines.push(note);
console.log(lines.join("\n") || "No notifications.");
return { mac: mac.length, phone: phone.length };
