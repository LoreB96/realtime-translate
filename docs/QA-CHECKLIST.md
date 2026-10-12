# QA Checklist — Realtime Translate

## M1 End-to-End Smoke Test

This is the final manual gate before tagging an M1 release. Run on a clean Windows machine with **VB-CABLE installed** (basic version is enough for M1; A+B is required for bidirectional in M2).

### Prerequisites

- Windows 10 or 11
- Node.js >= 20
- VB-CABLE installed: https://vb-audio.com/Cable/ (reboot after install)
- An OpenAI API key with access to `gpt-realtime-translate` model
- Working microphone and headphones

### Setup (one-time)

1. **Configure CABLE Output monitoring** (so you can hear what the app sends to the cable):
   - Win+R → `mmsys.cpl` → Recording tab
   - Right-click **CABLE Output** → Properties → Listen tab
   - Check "Listen to this device", choose your real headset, click OK

### Procedure

1. **Build and launch:**
   ```powershell
   npm install
   npm run dev
   ```
   Wait for the Electron window to open.

2. **Save API key:**
   - In the M1 Test Rig window, paste your OpenAI API key in the input
   - Click Save
   - Confirm the input is replaced by a masked display ending in your key's last 4 chars

3. **Pick devices:**
   - Microphone: select your real headset mic
   - Output: select **CABLE Input (VB-Audio Virtual Cable)** — should show `(recommended)` if detected

4. **Start translation:**
   - Click `Start translation (PT → EN)`
   - Status line should change: `idle` → `connecting` → `active`

5. **Speak Portuguese for 5–10 seconds:**
   - Suggested phrase: "Olá, meu nome é Gabriel. Estou testando o aplicativo de tradução em tempo real."

6. **Verify English output:**
   - You should hear English coming back through your headset (via the CABLE Output monitoring you configured)
   - Latency: typically 1–3 seconds between when you finish speaking and when the English starts

7. **Stop:**
   - Click `Stop`
   - Status returns to `idle`

8. **Close the app cleanly** (X button or Alt+F4).

### Pass criteria

- [ ] App launches without crash
- [ ] API key save round-trips (close + reopen → still saved)
- [ ] Devices listed in dropdowns (mic + CABLE Input visible)
- [ ] Status transitions cleanly idle → connecting → active
- [ ] English audio is audible through headset within ~3 seconds of speaking PT
- [ ] Stop returns to idle without crash
- [ ] App closes cleanly

### Common failures

- **Status stays "connecting":** check API key validity, check network, check console output for errors
- **No English audio heard:** verify CABLE Output monitoring is enabled and routing to headset (`mmsys.cpl` → Recording → CABLE Output Properties → Listen)
- **Mic not capturing:** check Windows mic permissions for the app (Settings → Privacy → Microphone)
- **Empty device dropdowns:** the offscreen window may have failed to enumerate. Check console output. Restart the app.

### After PASS

Update `docs/superpowers/spikes/2026-05-07-setsinkid-spike.md`'s "M1 end-to-end smoke" section with date, hardware, and result. Then tag the release:

```powershell
git tag -a v0.1.0-m1 -m "M1: foundation + unidirectional PT->EN through CABLE"
```

### After FAIL

Capture the exact error in console output and surfaces in the UI. Open an issue or share the log so a follow-up can investigate.

---

## M2 End-to-End Smoke Test (Bidirectional)

Final manual gate before tagging M2.

### Prerequisites

- All M1 prerequisites
- **VB-CABLE A+B** installed (separate from basic VB-CABLE): https://vb-audio.com/Cable/ (donationware variant; reboot after install). M1 used the basic cable; M2 needs both A and B for proper isolation.
- A second device (phone, tablet, second laptop) with Google Meet to act as the remote participant
- Both directions of audio routing tested and working

### Setup (one-time, but **DIFFERENT from M1**)

> ⚠️ **DO NOT enable "Listen to this device" on CABLE-A Output or CABLE-B Output for M2.** That M1 debugging affordance creates an acoustic feedback loop in M2: the app plays the EN translation through your headset (via the M1 monitoring), the headset mic picks it up, the app captures it as new "PT speech", queues it for translation, and latency balloons to 30+ seconds. M2's UI plays Direction B's translation directly to your headset via `setSinkId` — no monitoring needed.
>
> If you set up M1 monitoring before, **disable it now**: `mmsys.cpl` → Recording → right-click `CABLE-A Output`/`CABLE-B Output` → Properties → Listen → uncheck "Listen to this device".

1. **Configure Google Meet on your PC:**
   - Open a test meeting (or any meeting where you control both ends)
   - Settings → Audio → **Microphone** = `CABLE-A Output`
   - Settings → Audio → **Speaker** = `CABLE-B Input`

2. **Configure your second device** (the "remote participant"):
   - Join the same Meet call from your phone/tablet/second laptop
   - Use its built-in mic and speaker (not routed through any cable)

### Procedure

1. **Build and launch:**
   ```powershell
   npm run dev
   ```

2. **Save API key** (or confirm `●●●●●●●●xxxx` shows last 4 chars).

3. **Pick devices:**
   - Microphone: your real headset mic
   - To Meet: `CABLE-A Input (VB-Audio Cable A)` — should auto-select with `(recommended)`
   - From Meet: `CABLE-B Output (VB-Audio Cable B)` — should auto-select with `(recommended)`
   - Headset: your real headphones (where Direction B's PT translation plays)

4. **Languages:** PT ↔ EN (default).

5. **Start translation.** Both status lines should show:
   - `A (pt → en): active`
   - `B (en → pt): active`
   Transitions: `idle → connecting → active`. If either stays in `connecting` for >10s, something is wrong.

6. **Test Direction A (you → them):** speak Portuguese into your headset mic. Within ~3 seconds, your second device (the Meet participant) should hear English audio. Sample phrase: _"Olá, tudo bem? Estou testando a tradução em tempo real."_

7. **Test Direction B (them → you):** speak English into your second device's mic (or have someone else do it). Within ~3 seconds, you should hear Portuguese in your PC headset. Sample phrase: _"Hello, can you hear me? This is a translation test."_

8. **Stop translation.** Both directions return to `idle`. Close cleanly.

### Pass criteria

- [ ] App launches without crash
- [ ] Both `cableA.playback` and `cableB.recording` auto-detected as `(recommended)`
- [ ] Both directions show `active` after Start
- [ ] PT→EN audible at the second device (latency ~1-3s)
- [ ] EN→PT audible in your headset (latency ~1-3s)
- [ ] No 30+ second latency (if so, see the warning above about Listen-to-this-device)
- [ ] Stop returns both directions to idle without crash
- [ ] App closes cleanly

### Degraded mode test (optional)

To verify spec §7 "modos degradados":
1. With both directions active, briefly disable Wi-Fi.
2. Both directions should transition to `reconnecting`.
3. Re-enable Wi-Fi. Both should return to `active`.
4. Alternatively, kill one cable (e.g., disable CABLE-B in Sound settings) and verify the other direction continues.

### Common failures

- **30+ second latency:** acoustic feedback loop. Disable "Listen to this device" on CABLE-A Output AND CABLE-B Output (see Setup warning above). Restart the app and retest.
- **Direction B silent:** check that your PC's Meet speaker is set to `CABLE-B Input` (not your real headset). The translation flow needs Meet to play into the cable, not directly to your ears.
- **Direction A silent (second device hears nothing):** check that your PC's Meet mic is set to `CABLE-A Output`. The app sends translated EN to the cable; Meet must read from there.
- **Echo/loop on Direction A:** if your second device's speaker is loud and near your headset mic, the EN it plays gets re-captured. Mute the second device's speaker, or use earbuds/headphones on it.
- **Same as M1 failures** (status stays connecting, mic permission, etc.) apply here too.

### After PASS

Update `docs/superpowers/spikes/2026-05-07-setsinkid-spike.md` with M2 smoke result. Tag the release:

```powershell
git tag -a v0.2.0-m2 -m "M2: bidirectional PT<->EN translation"
```

---

## M3 End-to-End Smoke Test (FloatingWidget UI)

Final manual gate before tagging M3. Exercises the new shipping UI: a transparent always-on-top floating bar that replaces the M2 BidirectionalTestRig, plus the SetupView one-time wizard, prefs persistence, and the reconnecting/error visualizations.

### Prerequisites

- All M2 prerequisites (VB-CABLE A+B, second-device Meet participant, no "Listen to this device" on cable outputs)
- A clean prefs file recommended for first-launch path verification:
  ```powershell
  Remove-Item "$env:APPDATA\realtime-translate\prefs.json" -ErrorAction SilentlyContinue
  Remove-Item "$env:APPDATA\realtime-translate\apikey.bin" -ErrorAction SilentlyContinue
  ```

### First-launch flow

1. **Build and launch:**
   ```powershell
   npm run dev
   ```
   Expected: SetupView window opens. The floating bar is NOT visible because the API key + 4 devices haven't been configured yet.

2. **Save API key in SetupView:** paste your OpenAI key, click Save. Confirm the input is replaced by a masked display ending in your key's last 4 chars.

3. **Pick all 4 devices** (mic, to-Meet = `CABLE-A Input`, from-Meet = `CABLE-B Output`, headset) per the M2 procedure. Confirm `(recommended)` shows for the cable entries.

4. **Click "Concluir setup → abrir barra".** Expected: the floating bar appears (centered above the taskbar, ~480×40, transparent, always-on-top), and the SetupView window closes.

5. **Verify devices/lang persisted:** close the app entirely (Alt+F4 on the bar). Run `npm run dev` again. Expected: bar appears immediately, SetupView is NOT shown — setup is remembered.

### Bar workflow

6. **Initial state** (after subsequent launches): bar shows orb (idle/grey), `PT ↔ EN` lang pair, ▶ play action button, ⚙ gear. Width ~150px.

7. **Click ▶ play.** Bar transitions: orb pulses accent → "Conectando…" status text → orb pulses accent + waveform animates + latency tag appears + ⏸ pause button. Width grows to ~290px.

8. **Test Direction A (you → them):** speak Portuguese for 5–10 seconds into your headset mic. Within ~3 seconds your second device should hear English. The latency tag updates to reflect the t1−t0 moving average.

9. **Test Direction B (them → you):** speak English on your second device. Within ~3 seconds you should hear Portuguese in your headset.

10. **Click ⏸ pause.** Bar returns to idle (orb grey, no waveform, ▶ play restored, lang pair visible). Devices stay selected.

11. **Click ▶ resume.** Reconnects within ~1-2s, no need to reselect devices/languages. Latency tag clears briefly then resumes.

12. **Drag the bar.** Move it to a different screen position. Close the app. Run `npm run dev` again. Expected: bar reappears at the dragged position.

13. **Click ⚙ gear.** Expected: SetupView window opens (with current devices/key already populated). Close it via the window X.

### Reconnecting / error states

14. **Reconnecting smoke (optional, real network):** with translation active, briefly disable Wi-Fi for 3-5 seconds. Expected: bar background tinges yellow, orb turns yellow and pulses fast, lang pair is replaced by `Reconectando · {origin}: tentativa N`, ⏸ pause stays visible. Re-enable Wi-Fi. Bar returns to active.

15. **Error smoke (optional, deliberate):** stop translation. Open SetupView via ⚙, replace the API key with an invalid value, save. Click ▶ on the bar. Expected: bar background tinges red, orb turns red, status shows the truncated error message (28 chars + ellipsis), action button becomes ↻ retry. Click ⚙ to reopen SetupView and restore the valid key.

### Pass criteria

- [ ] First-launch routes to SetupView; bar does not appear pre-setup
- [ ] "Concluir setup" button enabled only when all 4 devices + key are present
- [ ] After Concluir setup, bar appears and SetupView closes
- [ ] Subsequent launches show the bar immediately (no SetupView)
- [ ] Bar shows the correct icon for each state (▶ idle, ⏸ active, ↻ error)
- [ ] Active state shows waveform + latency tag
- [ ] Pause/resume works without device reselection
- [ ] Drag persists across restarts
- [ ] Reconnecting state visually distinct (yellow tint + pulsing orb + status text)
- [ ] Error state visually distinct (red tint + retry button + truncated message)
- [ ] ⚙ opens SetupView; lang pair click also opens it
- [ ] Production build (`npm run build`) emits 3 HTML entries (offscreen, floating-widget, setup-view) and no `index.html`

### Common failures

- **Bar invisible after Concluir setup:** check that prefs.json got written (`$env:APPDATA\realtime-translate\prefs.json`). If empty, the IPC handler probably failed — check console output.
- **Clicks on the empty margins around the bar do nothing:** the floating BrowserWindow is 480×40 but the visible bar is `width: auto` (~150–340 px depending on state). Pixels outside the bar are transparent but still belong to the window — they capture clicks rather than passing through. M3 ships with this limitation; click-through forwarding (`setIgnoreMouseEvents` per pointer region) is deferred to M4+.
- **SetupView opens after every launch:** prefs aren't being read on startup, or the "all 4 devices + key present" gate is too strict. Check `isSetupComplete()` in `src/main/app.ts` and the bootstrap flow.
- **Reconnecting tint never appears:** the bar reads from the bidirectional store; check that `cableA`/`cableB` status events propagate to the floating widget renderer.
- **Same as M1/M2 failures** (status stays connecting, mic permission, etc.) apply here too.

### After PASS

Update `docs/superpowers/spikes/2026-05-07-setsinkid-spike.md` with the M3 smoke result mirroring the M1/M2 entries. Then tag:

```powershell
git tag -a v0.3.0-m3 -m "M3: FloatingWidget UI + prefs persistence + backend follow-ups"
```

---

## M4 End-to-End Smoke Test (SetupView Wizard + i18n + Cost)

Final manual gate before tagging M4.

### Prerequisites

- All M3 prerequisites
- Clean prefs file recommended for first-launch verification:
  ```powershell
  Remove-Item "$env:APPDATA\realtime-translate\prefs.json" -ErrorAction SilentlyContinue
  Remove-Item "$env:APPDATA\realtime-translate\apikey.bin" -ErrorAction SilentlyContinue
  ```

### Procedure

1. **`npm run dev`** — SetupView opens at Step 1 of 6 (Welcome with audio flow diagram).

2. **Welcome step:**
   - [ ] Diagram renders 2 directions with mic/headphones/Meet icons
   - [ ] "Begin →" routes to Step 2

3. **API Key step (Step 2):**
   - [ ] Input field accepts text, masks the value
   - [ ] Invalid key (no `sk-` prefix) shows error
   - [ ] Valid key saves; the masked hint appears
   - [ ] "Avançar →" routes to Step 3

4. **VB-CABLE step (Step 3):**
   - [ ] If installed: green ✓ heading + Avançar enabled
   - [ ] If NOT installed: warning + Download button + "Já instalei, re-detectar" button
   - [ ] Re-detect after install transitions to ✓ state

5. **Devices step (Step 4):**
   - [ ] All 4 dropdowns populated; cable A/B auto-recommended
   - [ ] Source + target language dropdowns show 72 languages alphabetically by English label
   - [ ] Avançar disabled until all 4 devices selected

6. **Meet config step (Step 5):**
   - [ ] 5 numbered screenshot cards render (placeholder PNGs OK if real ones not authored yet)
   - [ ] "Já configurei" checkbox enables Avançar

7. **Test Translation step (Step 6):**
   - [ ] "Testar PT → EN" button runs the test; passes within ~10s if pipeline OK
   - [ ] "Testar EN → PT" button runs; user confirmed prompt appears; user clicks "Yes" → pass
   - [ ] After both pass, "Concluir setup →" enabled
   - [ ] Click → bar appears, SetupView closes

8. **Subsequent launch (close + `npm run dev` again):**
   - [ ] Bar appears immediately, no SetupView
   - [ ] Click ⚙ on bar → SetupView opens at #/review (NOT #/wizard/1)

9. **Review screen:**
   - [ ] 5 sections render with current values + status icons
   - [ ] "Edit" on Languages → routes to /wizard/4?mode=edit (footer says "Salvar e voltar")
   - [ ] After save, returns to /review with updated value

10. **Cost meter (FloatingWidget):**
    - [ ] During active translation, `$0.XX` tag visible after latency
    - [ ] Updates ~1Hz
    - [ ] After 60s of bidirectional active, value is approximately `$0.07` (= 0.034 × 2)
    - [ ] Pause → cost disappears (no longer in active state)

11. **i18n:**
    - [ ] Language dropdown in SetupView titlebar shows current (PT-BR or EN-US)
    - [ ] Switch to EN-US → window reloads, all strings shown in English
    - [ ] Switch back to PT-BR → all strings in Portuguese
    - [ ] OS locale auto-detect: rename prefs.json (or remove uiLanguage from it), launch app — UI matches `app.getLocale()` if pt-BR or en-US, else falls back to en-US

### Pass criteria

- [ ] All 11 procedure items above checked
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test -- --run` ≥ 100 tests passing
- [ ] `npm run build` produces 3 HTML entries (offscreen, floating-widget, setup-view), no `index.html`

### After PASS

```powershell
git tag -a v0.4.0-m4 -m "M4: SetupView wizard + i18n + cost dashboard"
```


---

## M5 End-to-End Smoke Test (Distribution + auto-update + UX leftovers)

Final manual gate before tagging M5. This adds packaged-installer testing on top of M4's wizard flow.

### Prerequisites

- All M4 prerequisites
- A clean Windows 11 user account or VM (so the install path is exercised end-to-end without leftover dev artifacts)
- The repo is at HEAD `v0.5.0-m5` (tag pending)

### Procedure

1. **Build the installer**
   ```bash
   npm run dist
   ```
   Produces:
   - `release/Realtime Translate Setup 0.5.0-m5.exe` (NSIS installer, ~106 MB)
   - `release/Realtime Translate 0.5.0-m5.exe` (portable, ~106 MB)
   - `release/latest.yml` (auto-update metadata)
   - `release/Realtime Translate Setup 0.5.0-m5.exe.blockmap`

2. **Install on a clean account / VM**
   - Run the NSIS installer
   - Verify: "Publisher: unknown" SmartScreen warning appears (expected — unsigned)
   - Click "More info → Run anyway"
   - Wizard pages through install location picker (per-user, no admin)
   - Verify: Start menu shortcut "Realtime Translate" + Desktop shortcut created
   - Verify: app icon (purple/cream loop) renders in installer chrome + shortcuts + taskbar
   - [ ] Installer completes without errors

3. **First launch on the installed app**
   - Launch from Start menu
   - SetupView opens at Step 1 (Welcome)
   - Verify: title bar shows "Realtime Translate"
   - Verify: app icon visible in taskbar (purple/cream)
   - Verify: `app.getVersion()` returns `0.5.0-m5` (DevTools console: `process.versions.electron`, `app.getVersion()` via main IPC, or check Settings → Apps & features)
   - [ ] Wizard renders correctly

4. **External link routing (Step 2 + Step 3)**
   - Step 2: click "Não tenho chave — me leve pro signup OpenAI"
   - Verify: opens in user's default browser (Chrome/Edge/etc.), NOT in an in-app BrowserWindow
   - Step 3 (after detection fails or for testing): click "Baixar VB-CABLE A+B"
   - Verify: opens vb-audio.com in default browser
   - [ ] Both links open externally

5. **Step 6 in-wizard ConfirmModal (Direction B)**
   - Run Direction B test
   - Verify: instead of native window.confirm dialog, an in-wizard modal appears with the question and Yes/No buttons styled with the project's design tokens
   - Verify: Escape key cancels the modal
   - Verify: clicking outside the modal cancels
   - [ ] Modal works as designed

6. **Bar right-click menu i18n**
   - After Concluir setup, the bar appears
   - Right-click the bar
   - Verify: "Configurações" / "Sair" (PT) or "Settings" / "Quit" (EN) — depending on uiLanguage
   - Switch UI language via the SetupView's titlebar dropdown; right-click bar again — strings reflect the new locale
   - [ ] Menu items translate

7. **Bar click-through on transparent margins**
   - Open a window underneath the bar (e.g., a text editor)
   - Click on a pixel ABOVE/BELOW the visible bar (within the 480x40 bounds but outside the visible region)
   - Verify: click registers on the underlying window (focus / interaction)
   - Click on the visible bar (the actual UI region)
   - Verify: click registers on the bar (e.g., gear button opens SetupView)
   - [ ] Click-through working on transparent areas, capture working on visible region

8. **meetConfirmed persistence (Step 5)**
   - Open SetupView via the bar's gear button
   - Click "Edit" on the Meet section in /review → goes to /wizard/5?mode=edit
   - Verify: the "Já configurei" / "I've configured it" checkbox is already checked (not reset)
   - Click Voltar then advance again to step 5 — checkbox state survives
   - [ ] Persists across navigation

9. **Stale-cable banner (Step 4)**
   - Manually set selectedToMeet to a non-CABLE device (e.g., physical speakers) via Step 4 dropdown — save and exit
   - Reopen SetupView in edit mode at /wizard/4
   - Verify: yellow warning banner appears: "Suas seleções de Saída/Captura não usam os cabos VB-CABLE recomendados"
   - Click "Usar recomendado"
   - Verify: dropdowns update to CABLE-A Input + CABLE-B Output, banner disappears
   - [ ] Banner shows + auto-fix works

10. **Auto-update flow (synthetic test)**
    - With v0.5.0 installed, prepare a synthetic v0.5.1 release on GitHub:
      - Bump `package.json` to `0.5.1` locally
      - `git tag -a v0.5.1 -m "synthetic test"`
      - `git push origin v0.5.1`
      - Wait for the release.yml workflow to complete (~5-10 min)
      - Confirm a v0.5.1 GitHub Release exists with `.exe` + `latest.yml` attached
    - Opt in to auto-update (off by default): `setx REALTIME_TRANSLATE_AUTO_UPDATE 1`, then sign out/in or open a new shell so the variable is visible (the portable exe never auto-updates)
    - Restart the installed v0.5.0 app
    - Wait 5+ seconds after launch — the auto-update check fires
    - Verify: `↑ Downloading v0.5.1…` badge appears on the bar (dim, not clickable yet)
    - Wait for download (~30s on a fast connection; latest.yml + .blockmap + .exe transfer)
    - Verify: badge changes to `↑ Restart to update v0.5.1` (brighter accent, clickable)
    - Click the badge
    - Verify: app restarts and the relaunched version reports `0.5.1`
    - [ ] Auto-update worked end-to-end

11. **Uninstall**
    - Settings → Apps → Installed apps → "Realtime Translate" → Uninstall
    - Verify: shortcuts removed, install dir cleaned, prefs.json + apikey.bin retained at `%APPDATA%\realtime-translate\` (per-user state survives uninstall by design)
    - [ ] Clean removal

### Pass criteria

- [ ] All 11 procedure items above checked
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test -- --run` ≥ 116 tests passing
- [ ] Code-signing warning is the only "scary" SmartScreen prompt; expected for unsigned MVP

### After PASS

```powershell
git tag -a v0.5.0-m5 -m "M5: distribution + auto-update + UX polish"
git push origin v0.5.0-m5
```

The release.yml workflow then builds + uploads artifacts to a GitHub Release matching the tag. Once that completes, anyone running v0.5.0 (or earlier dev builds with auto-update enabled) gets prompted on next launch.

---

## Audio health, diagnostics & passthrough

Run on Windows with VB-CABLE A+B installed and setup completed. Use a real call (Meet, Teams or Zoom) with a second device as the other party. Check the chip and the Troubleshooting screen at least once in each UI language (Português, English, Italiano).

### Passthrough (direct mode)

- [ ] With the bar idle and the setup window closed, the bar shows a dim **Direct audio** label; its tooltip says the call is untranslated and ▶ translates
- [ ] The other party hears you untranslated; you hear them in your headset
- [ ] Press ▶: direct audio stops (no double audio) and translation starts; press ■: direct audio resumes within ~1 s
- [ ] Opening Settings stops direct audio; closing it resumes it

### Silence gate

- [ ] Start translation and stay silent on both sides for 60 s: no invented phrases ("I'm ready, let's talk", "Thank you", …) reach either side
- [ ] The cost meter grows noticeably slower while both sides are silent than while talking
- [ ] Speaking softly (normal headset level) is still translated; the gate doesn't clip the start of sentences

### Health chip (one item per code)

For each: check the chip color and short label, that the tooltip says what is wrong AND how to fix it, and that a click opens Troubleshooting.

- [ ] `call-silent` (amber, "No audio from call"): set the call app's Speakers to the real headset instead of CABLE-B and translate for >10 s while the other party talks
- [ ] `mic-silent` (amber, "Mic muted"): mute the mic (hardware or Windows) during translation
- [ ] `device-missing` / headset (red, "Headset disconnected"): unplug a USB/BT headset during translation
- [ ] `device-missing` / mic (red, "Mic disconnected"): unplug the mic during translation
- [ ] `device-missing` / cable (red, "CABLE-A missing" / "CABLE-B missing"): disable a CABLE endpoint in Windows Sound during translation
- [ ] `device-failed` (red): hold the mic in exclusive mode from another app, then start translation
- [ ] `audio-suspended` (red, "Audio paused"): sleep and resume the PC during translation
- [ ] Fixing the cause clears the chip without restarting the app
- [ ] Worst-case width (translating + latency + cost + chip + update badge): nothing overflows the bar and the quit button stays visible

### Device unplug / replug recovery

- [ ] Unplug the headset during translation → chip appears; replug → audio resumes on the headset automatically and the chip clears
- [ ] Same while idle in direct mode: unplug/replug the headset → direct audio resumes
- [ ] Disable then re-enable CABLE-B Output in Windows Sound → capture resumes without restarting the app

### Audio check (Troubleshooting screen)

- [ ] Right-click bar → Troubleshooting opens the screen; Settings → "Troubleshooting & audio check" → Open also works
- [ ] The device-name box shows this PC's exact CABLE-A Output / CABLE-B Input labels; Copy puts the name on the clipboard
- [ ] Running the check while translating shows "Stop the translation first" and nothing else happens
- [ ] Running it while idle, speaking and pressing "Test speakers" in the call app: spinner while running, then every check passes and a test tone plays on the headset
- [ ] With the call app's speaker on the wrong device, "Sound from the call app arrives" fails and the fix names CABLE-B Input
- [ ] With the mic muted, "Your voice reaches the app" warns/fails with a fix and shows the measured level in dB
- [ ] "Problems right now" lists the live health issues with fixes, or "No problems detected right now"
- [ ] The Meet/Teams/Zoom/Windows guides and the FAQ expand and show the exact device names
- [ ] Wizard Step 5 shows the device-name box, the noise-cancellation warning and the "Guides for Teams, Zoom and Windows" button

---

## M6 Assistant (live transcript, typed speech, reply suggestions)

Final manual gate for M6. Run on Windows with VB-CABLE A+B installed, setup completed and a real call (Meet, Teams or Zoom) with a second device as the other party. Use an OpenAI key with access to `gpt-4o-mini-transcribe`, `gpt-4o-mini-tts` and `gpt-5-mini`. For the local-LLM checks install [Ollama](https://ollama.com) and run `ollama pull qwen3:8b`.

**Scope:** M6 ships OpenAI speech-to-text only. Local Whisper, the `app://` production origin and COOP/COEP are deferred to M7, so there are no `crossOriginIsolated`, model-download or model-cache checks here.

### Automated gate (verified 2026-10-12 by U12)

- [x] `npm run typecheck` clean
- [x] `npm run lint` clean
- [x] `npx vitest run`: 49 files, 558 tests passing (baseline before M6: 243)
- [x] `npm run build` passes (`out/renderer/transcript.html` emitted next to the other pages)
- [x] Static privacy check: `grep -rnE "logger\.(info|warn|error|debug)\([^)]*(text|original|translated|content|prompt|suggest)" src/main` has no hits; every logger call in `src/main/{transcript,llm,tts,stt,assistant}` logs event names, codes, counts, durations and model ids only
- [ ] Optional packaged smoke (`npm run dist`, run `release/win-unpacked`): bar, setup and direct audio work; the transcript window opens from the bar menu (it loads from `file://` like the other pages); OpenAI STT produces entries; typed speech is audible in the call

### Opening the assistant

- [ ] Right-click the bar: the first item is **Live transcript** and it opens the transcript window; a second click focuses the same window (single instance)
- [ ] Settings → Review shows a 7th row **Assistant: transcript, AI, voice** with the current transcription engine and AI model; Open goes to `#/assistant`
- [ ] Transcript window menu → Assistant settings opens Settings on `#/assistant` **and direct audio keeps playing** (the call is not cut)
- [ ] "Open the transcript window when the app starts" on → quit and relaunch: the window opens after the bar (only when setup is complete)
- [ ] Pin toggle keeps the window above the call app; size and position persist across relaunch
- [ ] Move the window to a second monitor, quit, disconnect that monitor, relaunch: the window comes back on a visible screen (off-screen bounds recovered)

### Live transcript

- [ ] Not translating, transcription off: the window shows the **Transcribe with OpenAI** call to action with the cost note; one click turns OpenAI STT on and the header says "Direct audio — transcribing with OpenAI"
- [ ] Without an OpenAI key the call-to-action button is disabled with the no-key hint; adding the key in Settings starts STT without a restart
- [ ] (§16.1) With OpenAI STT and no translation, speech on both sides appears within about 3 s of the speaker pausing; direct audio shows no added latency or gaps
- [ ] (§16.2) While translating, both sides appear with the translation text, with no extra settings; ▶ stops STT (no double billing) and ■ resumes it
- [ ] Leave the mic idle for 10 min in direct mode (`pass-A` parks): STT for A stops, B keeps transcribing; speak again (wake) and A transcribes again
- [ ] "Also transcribe the original speech while translating" on, then Start: the source-language line appears, or an `input-transcript-unsupported` notice appears and translation continues correctly in both directions (see verification notes)
- [ ] "Translate what the other person says when not translating" on: `them` entries in direct mode show a line in your language
- [ ] Bubbles: `me` right/accent, `them` left; caret on unfinished entries; time on hover; scrolling up shows "Jump to latest"
- [ ] Clear (with confirm) empties the window; Export .txt and Export .md save files with both languages; Cancel in the save dialog writes nothing
- [ ] Offline (disable the network) with OpenAI STT: the header shows an error with Retry; direct audio is unaffected; network back + Retry resumes

### Typed speech

- [ ] (§16.3) Source it / target en, type "Riesci a sentirmi?" and press Enter: English is spoken into the call in direct mode **and** while translating; the entry shows original + translation, a keyboard badge, and reaches done
- [ ] Two messages sent quickly are spoken in submission order; Stop cancels both (the unfinished one shows cancelled, without Retry)
- [ ] "Translate to <lang>" off: the text is spoken as typed; the toggle is hidden when both languages are equal
- [ ] Shift+Enter inserts a newline; the counter stops at 2000 characters
- [ ] With Settings open on the wizard/review (not `#/assistant`), sending is refused with `tts-busy-setup`
- [ ] Without an "Output to call" (CABLE-A) device: `tts-no-device`
- [ ] Disable then re-enable CABLE-A Input in Windows Sound, then send a message: it is spoken (TTS streams reopen)
- [ ] A TTS stream event (e.g. the CABLE-A unplug above) does not restart call audio or show a health chip
- [ ] "Also play it on my headset" on: you also hear the spoken message in the headset; the echo warning is shown in Settings

### Reply suggestions

- [ ] (§16.4) The other person asks a question ending in "?": up to 3 suggestions appear within about 5 s while translating (`gpt-5-mini`) and about 6 s in direct mode with OpenAI STT
- [ ] Clicking a card copies it into the composer; Speak plays it into the call; speaking it does not clear the suggestions
- [ ] Answering by voice (2+ words) clears ready suggestions; keyboard noise does not
- [ ] "Suggest" works with automatic suggestions off; turning suggestions off hides the panel
- [ ] Direct mode without transcription shows the "Turn on transcription so suggestions can follow the call" hint in the suggestions panel

### AI model (LLM)

- [ ] OpenAI preset: Test connection shows ✓ and the time in ms; "Load models" lists chat models only
- [ ] (§16.5) Ollama preset (`http://127.0.0.1:11434/v1`, model `qwen3:8b`): Test connection works (the first test may take long while the model loads); typed-speech translation and suggestions work
- [ ] Stop Ollama: Test and suggestions show `llm-unreachable` with the "Is Ollama running? Start it, then run ollama pull …" hint; translation and direct audio are unaffected
- [ ] Wrong model name: `llm-model-missing` with the hint
- [ ] Base URL `http://192.168.x.x:11434/v1`: the insecure-URL warning is shown; `http://127.0.0.1` shows none
- [ ] The custom API key field appears only for non-OpenAI hosts; a saved key shows only its last 4 characters; the OpenAI key is never sent to a non-OpenAI host
- [ ] LM Studio preset (`http://127.0.0.1:1234/v1`) works if LM Studio is installed (optional)

### Privacy (§16.7)

- [ ] After using transcript, typed speech, suggestions and their-speech translation, search `%APPDATA%\realtime-translate\logs\*.jsonl` for one spoken sentence and one typed sentence: **not found**
- [ ] Nothing is written to disk except on Export

### i18n

- [ ] Switch the UI to Italiano and Português: the transcript window, `#/assistant`, the bar menu item, the Review row and every error message are translated (no raw keys, no English leftovers)

### M6 verification notes (live API checks, UNVERIFIED until filled in)

These depend on live OpenAI / Ollama behaviour and are not covered by unit tests. Record the result and the date; each item is isolated in one file so a fix stays local.

| Item | Where the code lives | Result |
|---|---|---|
| GA transcription `session.update` shape accepted (`type: 'transcription'`, `audio.input.format` / `transcription` / `noise_reduction`) | `src/main/stt/openaiSttProtocol.ts` | UNVERIFIED |
| `turn_detection: null` accepted on the transcription session (client-driven commit) | `src/main/stt/openaiSttProtocol.ts` | UNVERIFIED |
| `language` (mini / 4o transcribe) vs `languages: [...]` (`gpt-live-transcribe`) | `src/main/stt/openaiSttProtocol.ts` | UNVERIFIED |
| Translate endpoint accepts or rejects `audio.input.transcription` in the second `session.update`; translation language stays correct in both cases (look for `input_transcription_rejected` in the log) | `src/main/translate/openaiSession.ts` | UNVERIFIED |
| `session.output_transcript.delta` emitted without extra settings | `src/main/translate/openaiSession.ts` | UNVERIFIED |
| `reasoning_effort: 'minimal'` accepted by `gpt-5-mini` on `/v1/chat/completions` | `src/main/llm/llmClient.ts` | UNVERIFIED |
| Ollama with `reasoning_effort: 'none'` (accepted, or the 400 retry without it kicks in) | `src/main/llm/llmClient.ts` | UNVERIFIED |
| TTS `response_format: 'pcm'` streams 24 kHz s16le mono and `instructions` is accepted by `gpt-4o-mini-tts` | `src/main/tts/ttsService.ts` | UNVERIFIED |

### Pass criteria

- [ ] All checks above done and the verification table filled in
- [ ] No transcript, typed or suggestion text in `userData/logs/*.jsonl`
- [ ] typecheck, lint, tests (≥ 400) and build green
