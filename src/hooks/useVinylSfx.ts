import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef } from "react";

const lidClickSource = require("../../assets/sfx/vinyl-lid-click.wav");
const manualRecordChangeSource = require("../../assets/sfx/manual-record-change.wav");

type AudioPlayer = ReturnType<typeof useAudioPlayer>;

type VinylSfxOptions = {
  enabled?: boolean;
};

const MANUAL_RECORD_CHANGE_DELAY_MS = 450;

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function useVinylSfx(options: VinylSfxOptions = {}) {
  const { enabled = true } = options;

  const lidClickPlayer = useAudioPlayer(lidClickSource);
  const manualRecordChangePlayer = useAudioPlayer(manualRecordChangeSource);

  const lastRecordChangeSfxAtRef = useRef(0);

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: "mixWithOthers",
    }).catch(() => {
      // Sound effects should never break playback/ui.
    });
  }, []);

  const replay = useCallback(
    (player: AudioPlayer) => {
      if (!enabled) return;

      try {
        player.seekTo(0);
        player.play();
      } catch {
        // Ignore audio failures.
      }
    },
    [enabled]
  );

  const playLidClick = useCallback(() => {
    if (!enabled) return;

    replay(lidClickPlayer);

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, [enabled, lidClickPlayer, replay]);

  const playManualRecordChange = useCallback(async () => {
    if (!enabled) return;

    const now = Date.now();

    if (now - lastRecordChangeSfxAtRef.current < 450) return;

    lastRecordChangeSfxAtRef.current = now;

    replay(manualRecordChangePlayer);

    void Haptics.selectionAsync().catch(() => {});

    await wait(MANUAL_RECORD_CHANGE_DELAY_MS);
  }, [enabled, manualRecordChangePlayer, replay]);

  return {
    playLidClick,
    playManualRecordChange,
  };
}