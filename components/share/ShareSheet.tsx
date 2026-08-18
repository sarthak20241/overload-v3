import { useRef, useState, ReactElement, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, Pressable, StyleSheet,
  ActivityIndicator, useWindowDimensions,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Portal } from '@/components/ui/Portal';
import { useSheetSlide } from '@/hooks/useSheetSlide';
import { useTheme } from '@/hooks/useTheme';
import { captureAndShare } from '@/lib/share/captureAndShare';
import { Spacing, FontSize, FontWeight } from '@/constants/theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  card: ReactElement;
}

export function ShareSheet({ visible, onClose, card }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { mounted, slideStyle } = useSheetSlide(visible, 300, 200);
  const captureRef = useRef<View>(null);
  const [sharing, setSharing] = useState(false);

  const previewScale = Math.min((windowWidth - 80) / 1080, 0.3);
  const previewW = 1080 * previewScale;
  const previewH = 1920 * previewScale;

  const handleShare = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    try {
      await captureAndShare(captureRef);
    } finally {
      setSharing(false);
    }
  }, [sharing]);

  if (!mounted) return null;

  return (
    <Portal>
      <View style={styles.backdrop} pointerEvents={visible ? 'auto' : 'none'}>
        {visible && (
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}
            onPress={onClose}
          />
        )}
        <Animated.View
          style={[
            styles.sheet,
            slideStyle,
            {
              backgroundColor: C.elevated,
              paddingBottom: insets.bottom + Spacing.lg,
              maxHeight: windowHeight * 0.85,
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: C.handle }]} />
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: C.foreground }]}>Share</Text>
            <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
              <Feather name="x" size={15} color={C.foreground} />
            </TouchableOpacity>
          </View>

          <View style={styles.previewWrap}>
            <View
              style={[
                styles.previewFrame,
                {
                  width: previewW,
                  height: previewH,
                  borderColor: C.borderSubtle,
                },
              ]}
            >
              <View style={{ transform: [{ scale: previewScale }], width: 1080, height: 1920 }}>
                {card}
              </View>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.shareBtn, sharing && styles.shareBtnDisabled]}
            onPress={handleShare}
            activeOpacity={0.8}
            disabled={sharing}
          >
            {sharing ? (
              <ActivityIndicator color="#0a0a0a" size="small" />
            ) : (
              <>
                <Feather name="share" size={18} color="#0a0a0a" />
                <Text style={styles.shareBtnText}>Share to Stories</Text>
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      </View>

      {/* Off-screen full-size card for capture */}
      <View
        style={styles.offscreen}
        pointerEvents="none"
      >
        <View ref={captureRef} collapsable={false}>
          {card}
        </View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: Spacing.xl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: Spacing.sm,
    marginBottom: Spacing.md,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  sheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewWrap: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  previewFrame: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#c8ff00',
    borderRadius: 14,
    paddingVertical: 16,
  },
  shareBtnDisabled: {
    opacity: 0.6,
  },
  shareBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: '#0a0a0a',
  },
  offscreen: {
    position: 'absolute',
    left: -5000,
    top: 0,
  },
});
