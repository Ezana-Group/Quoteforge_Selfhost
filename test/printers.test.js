"use strict";
// Tests the printer adapters against simulated printers (no hardware, no DOM).
const dgram = require("dgram");
const http = require("http");
const crypto = require("crypto");
const P = require("../printers");

let fail = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };
const freeUdpPort = () => new Promise((resolve) => { const s = dgram.createSocket("udp4"); s.bind(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  // ---- helpers
  check("private IPv4 ranges accepted", ["10.0.0.5", "192.168.1.42", "172.16.5.5", "172.31.0.1", "127.0.0.1", "169.254.1.1"].every(P.isPrivateIPv4));
  check("public / bad addresses rejected", ["8.8.8.8", "172.32.0.1", "1.2.3", "abc", "", null, "192.168.1.256"].every((x) => !P.isPrivateIPv4(x)));
  check("subnet text is normalised", P.parseSubnetBase("192.168.5.0/24") === "192.168.5" && P.parseSubnetBase("10.1.2") === "10.1.2" && P.parseSubnetBase(" 192.168.5.0 ") === "192.168.5");
  check("public or malformed subnets rejected", P.parseSubnetBase("8.8.8.0/24") === null && P.parseSubnetBase("192.168.5.0/16") === null && P.parseSubnetBase("hello") === null);

  // ---- Bambu announcement parsing
  const bambuMsg = [
    "NOTIFY * HTTP/1.1", "HOST: 239.255.255.250:1990", "Server: Buildroot/2018.02-rc3 UPnP/1.0 ssdpd/1.8",
    "Location: 192.168.1.64", "NT: urn:bambulab-com:device:3dprinter:1", "NTS: ssdp:alive", "USN: 01P00A123456789",
    "Cache-Control: max-age=1800", "DevModel.bambu.com: C12", "DevName.bambu.com: Workshop P1S", "DevSignal.bambu.com: -61",
    "DevConnect.bambu.com: lan", "DevBind.bambu.com: free", "DevVersion.bambu.com: 01.07.00.00", "", "",
  ].join("\r\n");
  const b = P.parseBambuAnnouncement(bambuMsg, { address: "192.168.1.99" });
  check("Bambu announcement parsed", b && b.ip === "192.168.1.64" && b.serial === "01P00A123456789" && b.model === "P1S" && b.name === "Workshop P1S" && b.lanMode === true, JSON.stringify(b));
  const cloud = P.parseBambuAnnouncement(bambuMsg.replace("DevConnect.bambu.com: lan", "DevConnect.bambu.com: cloud"), { address: "1.1.1.1" });
  check("cloud-mode printer reports LAN mode off", cloud && cloud.lanMode === false);
  check("unrelated UDP traffic ignored", P.parseBambuAnnouncement("NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nUSN: uuid:abc\r\n\r\n", { address: "1.1.1.1" }) === null);
  check("unknown model code falls back to readable text", P.friendlyBambuModel("3DPrinter-X1-Carbon") === "X1 Carbon" && P.friendlyBambuModel("ZZ9") === "ZZ9");

  // ---- Bambu listening over real UDP sockets
  const bPort = await freeUdpPort();
  const listening = P.listenForBambu({ ports: [bPort], listenMs: 700 });
  await new Promise((r) => setTimeout(r, 150));
  const sender = dgram.createSocket("udp4");
  await new Promise((r) => sender.send(Buffer.from(bambuMsg), bPort, "127.0.0.1", r));
  await new Promise((r) => sender.send(Buffer.from(bambuMsg), bPort, "127.0.0.1", r)); // repeats must not duplicate
  sender.close();
  const heard = await listening;
  check("listener hears a Bambu printer once", heard.length === 1 && heard[0].serial === "01P00A123456789", JSON.stringify(heard));
  const busy = dgram.createSocket({ type: "udp4", reuseAddr: false });
  await new Promise((r) => busy.bind(0, "0.0.0.0", r));
  const noThrow = await P.listenForBambu({ ports: [busy.address().port], listenMs: 200 }).then(() => true, () => false);
  busy.close();
  check("a port already in use does not crash discovery", noThrow);

  // ---- Elegoo SDCP discovery
  const sdcpUdpPort = await freeUdpPort();
  const responder = dgram.createSocket("udp4");
  responder.on("message", (msg, rinfo) => {
    if (msg.toString() === "M99999") responder.send(Buffer.from(JSON.stringify({ Id: "x", Data: { Name: "Centauri", MachineName: "Centauri Carbon", BrandName: "ELEGOO", MainboardIP: "192.168.1.77", MainboardID: "abc123", FirmwareVersion: "V1.1.0" } })), rinfo.port, rinfo.address);
  });
  await new Promise((r) => responder.bind(sdcpUdpPort, "127.0.0.1", r));
  const sd = await P.discoverSdcp({ port: sdcpUdpPort, address: "127.0.0.1", listenMs: 500 });
  responder.close();
  check("Elegoo SDCP printer discovered", sd.length === 1 && sd[0].ip === "192.168.1.77" && sd[0].mainboardId === "abc123" && sd[0].model === "Centauri Carbon", JSON.stringify(sd));
  check("junk replies are ignored", P.parseSdcpReply(Buffer.from("not json"), { address: "1.1.1.1" }) === null && P.parseSdcpReply(Buffer.from("{}"), { address: "1.1.1.1" }) === null);

  // ---- Elegoo SDCP status over a simulated WebSocket server
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  function frame(text) {
    const payload = Buffer.from(text);
    const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([payload.length >> 8, payload.length & 255])]);
    return Buffer.concat([head, payload]);
  }
  let receivedRequest = null;
  const wsServer = http.createServer();
  wsServer.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", (d) => {
      // client frames are masked
      let len = d[1] & 0x7f, off = 2;
      if (len === 126) { len = d.readUInt16BE(2); off = 4; }
      const mask = d.slice(off, off + 4); const data = Buffer.from(d.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      receivedRequest = JSON.parse(data.toString());
      const status = { Topic: "sdcp/status/abc123", Status: { CurrentStatus: [1], TempOfNozzle: 219.6, TempTargetNozzle: 220, TempOfHotbed: 59.8, TempTargetHotbed: 60, PrintInfo: { Status: 13, Progress: 42, Filename: "benchy.gcode", CurrentLayer: 10, TotalLayer: 100 } } };
      socket.write(frame(JSON.stringify(status)));
    });
  });
  await new Promise((r) => wsServer.listen(0, "127.0.0.1", r));
  const wsPort = wsServer.address().port;
  const st = await P.fetchSdcpStatus("127.0.0.1", wsPort, "abc123", 3000);
  check("SDCP request names the printer's mainboard", receivedRequest && receivedRequest.Data && receivedRequest.Data.MainboardID === "abc123" && receivedRequest.Data.Cmd === 0, JSON.stringify(receivedRequest));
  check("SDCP status parsed (state, progress, temperatures, file)", st.ok && st.state === "printing" && st.progressPercent === 42 && st.nozzleTemp === 220 && st.nozzleTarget === 220 && st.bedTemp === 60 && st.fileName === "benchy.gcode", JSON.stringify(st));
  wsServer.close();
  const refused = await P.fetchSdcpStatus("127.0.0.1", wsPort, "abc123", 1500);
  check("SDCP reports a clear error when the printer is unreachable", refused.ok === false && /connect|closed|Timed out/i.test(refused.error), refused.error);
  check("SDCP state labels", P.sdcpState([0], 0) === "idle" && P.sdcpState([1], 13) === "printing" && P.sdcpState([], 9) === "complete" && P.sdcpState([], 99) === "status 99");

  // ---- Duet / RepRapFirmware
  let duetStatus = "processing";
  const duet = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/rr_model?key=state.status")) res.end(JSON.stringify({ key: "state.status", flags: "", result: duetStatus }));
    else if (req.url.startsWith("/rr_model?key=job")) res.end(JSON.stringify({ key: "job", flags: "", result: { file: { fileName: "0:/gcodes/part.gcode", size: 2000 }, filePosition: 500 } }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise((r) => duet.listen(0, "127.0.0.1", r));
  const dPort = duet.address().port;
  const ds = await P.fetchDuetStatus("127.0.0.1", dPort, 2000);
  check("Duet status parsed (printing, 25%, file name)", ds.ok && ds.state === "printing" && ds.progressPercent === 25 && ds.fileName === "part.gcode", JSON.stringify(ds));
  duetStatus = "idle";
  check("Duet idle state", (await P.fetchDuetStatus("127.0.0.1", dPort, 2000)).state === "idle");
  check("Duet response recognised only in the right shape", P.isDuetResponse({ key: "state.status", result: "idle" }) && !P.isDuetResponse({ result: "idle" }) && !P.isDuetResponse(null));
  duet.close();
  const dBad = await P.fetchDuetStatus("127.0.0.1", dPort, 1000);
  check("Duet unreachable gives a clear error", dBad.ok === false && /Duet/.test(dBad.error), dBad.error);

  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("FAIL crashed: " + e.stack); process.exit(1); });
