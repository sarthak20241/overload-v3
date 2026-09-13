// Medical disclaimer required by Google Play's Health Content and Services
// policy. Play rejected an update (2026-09-13) because the app never said it
// is not a medical device and never pointed users to a healthcare
// professional. Keep BOTH sentences in every variant: reviewers look for each.
import { StyleProp, StyleSheet, Text, TextStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { FontSize } from '@/constants/theme';

export const MEDICAL_DISCLAIMER_SHORT =
  'Drona is a training coach, not a medical professional. For medical advice, diagnosis, or treatment, talk to a doctor or other healthcare professional.';

export const MEDICAL_DISCLAIMER_FULL =
  'Overload is not a medical device. It does not diagnose, treat, cure, or prevent any medical condition. Coach Drona gives training guidance, not medical advice. Always consult a doctor or other qualified healthcare professional for medical advice, diagnosis, or treatment, and before starting a new exercise or nutrition program.';

export function MedicalDisclaimer({
  variant = 'full',
  style,
}: {
  variant?: 'short' | 'full';
  style?: StyleProp<TextStyle>;
}) {
  const { C } = useTheme();
  return (
    <Text
      style={[styles.text, { color: C.textDim }, style]}
      accessibilityRole="text"
    >
      {variant === 'short' ? MEDICAL_DISCLAIMER_SHORT : MEDICAL_DISCLAIMER_FULL}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: FontSize.xs, lineHeight: 14, textAlign: 'center' },
});
