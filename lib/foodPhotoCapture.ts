/**
 * A captured meal photo, made ready to send (lib/foodPhoto has the rules).
 *
 * One JPEG pass: the camera's photo is decoded to an Image with its
 * orientation applied (Photo.toImageAsync), redrawn at the upload size, and
 * encoded once at PHOTO_JPEG_QUALITY. The redraw is done even when the photo
 * is already small, because drawing is what bakes the orientation into the
 * pixels: a model reading a sideways photo reads it worse, and an EXIF flag
 * alone may not be honoured.
 */

import { File } from 'expo-file-system';
import type { Photo } from 'react-native-vision-camera';

import { fitLongEdge, PHOTO_JPEG_QUALITY, type PhotoShot } from '@/lib/foodPhoto';

export async function preparePhoto(photo: Photo): Promise<PhotoShot> {
  const image = await photo.toImageAsync();
  try {
    const size = fitLongEdge(image.width, image.height);
    if (!size) throw new Error('empty photo');
    const small = await image.resizeAsync(size.width, size.height);
    try {
      const path = await small.saveToTemporaryFileAsync('jpg', PHOTO_JPEG_QUALITY);
      const uri = path.startsWith('file://') ? path : `file://${path}`;
      const data = await new File(uri).base64();
      return { media_type: 'image/jpeg', data, uri, width: small.width, height: small.height };
    } finally {
      small.dispose();
    }
  } finally {
    image.dispose();
    photo.dispose();
  }
}

/** Remove the resized files once they are sent or thrown away. */
export function discardShots(shots: { uri: string }[]): void {
  for (const s of shots) {
    try {
      const f = new File(s.uri);
      if (f.exists) f.delete();
    } catch {
      // Best effort: a leftover cache file is not worth an error.
    }
  }
}
