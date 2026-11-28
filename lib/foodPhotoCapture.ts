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

import {
  centerDistanceM, fitLongEdge, PHOTO_JPEG_QUALITY, photoScaleFrom, type PhotoScale, type PhotoShot,
} from '@/lib/foodPhoto';

/**
 * The photo's real-world scale from its depth data, or null. Only a sensor
 * that measures in metres counts (accuracy "absolute": LiDAR); a two-camera
 * depth map is relative and would be a wrong number said with confidence.
 * Never throws: scale is a hint, and a photo without one is still a photo.
 */
export async function readPhotoScale(photo: Photo): Promise<PhotoScale | null> {
  try {
    const depth = photo.depth;
    if (!depth || !depth.isValid || depth.depthDataAccuracy !== 'absolute') return null;
    const metres = depth.pixelFormat === 'depth-32-bit' ? depth : await depth.convertAsync('depth-32-bit');
    try {
      const values = new Float32Array(metres.getDepthData());
      const distance = centerDistanceM(values, metres.width, metres.height, Math.floor(metres.bytesPerRow / 4));
      const cal = photo.calibrationData ?? depth.cameraCalibrationData;
      const lens = cal
        ? { matrix: cal.cameraIntrinsicMatrix, width: cal.intrinsicMatrixReferenceDimensions.width, height: cal.intrinsicMatrixReferenceDimensions.height }
        : null;
      return photoScaleFrom(distance, lens);
    } finally {
      if (metres !== depth) metres.dispose();
    }
  } catch {
    return null;
  }
}

export async function preparePhoto(photo: Photo): Promise<PhotoShot> {
  // Before the photo is disposed below.
  const scale = await readPhotoScale(photo);
  // The photo is disposed however this ends, a failed decode included.
  let image: Awaited<ReturnType<Photo['toImageAsync']>>;
  try {
    image = await photo.toImageAsync();
  } catch (e) {
    photo.dispose();
    throw e;
  }
  try {
    const size = fitLongEdge(image.width, image.height);
    if (!size) throw new Error('empty photo');
    const small = await image.resizeAsync(size.width, size.height);
    try {
      const path = await small.saveToTemporaryFileAsync('jpg', PHOTO_JPEG_QUALITY);
      const uri = path.startsWith('file://') ? path : `file://${path}`;
      try {
        const data = await new File(uri).base64();
        return { media_type: 'image/jpeg', data, uri, width: small.width, height: small.height, ...(scale ? { scale } : {}) };
      } catch (e) {
        // The file is written but will never be a shot: remove it here.
        discardShots([{ uri }]);
        throw e;
      }
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
    // A kept Retry copy carries no file.
    if (!s.uri) continue;
    try {
      const f = new File(s.uri);
      if (f.exists) f.delete();
    } catch {
      // Best effort: a leftover cache file is not worth an error.
    }
  }
}
