# Ballu Syncleo for Homebridge

[Русский](README.ru.md) · English

A community Homebridge plugin for local control of the Ballu ONEAIR ASP-100. It discovers the breezer over mDNS and talks to it over Syncleo UDP. Verified on an ASP-100 with Wi-Fi firmware 1.38 and Homebridge 2.5.0 on ARMv7.

- Turn the breezer on or off and select one of seven fan speeds.
- View CO₂ in ppm on devices that report it. The HomeKit elevated CO₂ indicator uses a fixed 1,000 ppm threshold.
- View Wi-Fi firmware and the module MAC address in accessory information. The MAC fills HomeKit’s serial-number field.
- Manage multiple breezers in the English or Russian settings UI.

## Install from source

Use Node.js 22.12+ or 24.x for development. Run the following in a clone of this repository.

```sh
npm ci
npm pack
```

Install the resulting archive into the npm location used by your Homebridge instance. For a global Homebridge installation, run `npm install -g ./homebridge-ballu-syncleo-0.1.4.tgz`. For the official Docker image, copy the archive into the mounted Homebridge storage and install it with `npm install ./homebridge-ballu-syncleo-0.1.4.tgz` from that directory inside the container.

## Configure

1. In HOMMYN, open the breezer settings, choose **Access control → Share**, and copy the full link.
2. In Homebridge, open **Plugins → Ballu Syncleo → Plugin configuration**. Add a breezer, enter its name and paste the link.
3. Save the configuration and restart Homebridge once to load the platform. Subsequent additions and edits apply while the platform is running.

Homebridge and the breezer need local UDP connectivity and mDNS discovery. For Docker on Linux, host networking is one way to make LAN multicast available. The share link contains a device credential. Homebridge stores it in its configuration and backups. Redact it before sharing diagnostics.

## Development

Run `npm ci` and `npm run build`. `npm pack --dry-run` lists the files included in the installable archive.

The Syncleo implementation uses the published [ASP-100 protocol notes](https://github.com/opensolutionshobby/asp-100-home-assistant/blob/main/PROTOCOL.md). This plugin is independently maintained. See [LICENSE](LICENSE).
