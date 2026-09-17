#!/usr/bin/env python3
"""
Extrae un frame de referencia del video con la línea de conteo (y la zona
del validador, si aplica) dibujadas encima, para calibrar visualmente antes
de correr el análisis completo con YOLO (que es mucho más lento). No hace
detección de personas.

Salida: un único JSON por stdout con la imagen en base64.
"""
import argparse
import base64
import json
import sys

import cv2


def parse_coords(raw, width, height):
    x1, y1, x2, y2 = (float(v) for v in raw.split(","))
    return (x1 * width, y1 * height), (x2 * width, y2 * height)


def parse_zone(raw, width, height):
    x1, y1, x2, y2 = (float(v) for v in raw.split(","))
    return (
        min(x1, x2) * width,
        min(y1, y2) * height,
        max(x1, x2) * width,
        max(y1, y2) * height,
    )


def encode_jpeg_data_uri(img, max_width=960, quality=80):
    h, w = img.shape[:2]
    if w > max_width:
        scale = max_width / w
        img = cv2.resize(img, (max_width, int(h * scale)))
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode("ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True)
    parser.add_argument("--line", default="0,0.5,1,0.5")
    parser.add_argument("--zone", default=None)
    parser.add_argument(
        "--position", type=float, default=0.3,
        help="Fracción (0-1) del video de donde tomar el frame (evita el arranque, que suele ser negro/borroso)",
    )
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"error": f"No se pudo abrir el video: {args.video}"}))
        sys.exit(1)

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    target_frame = max(0, min(total_frames - 1, int(total_frames * args.position)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)

    ok, frame = cap.read()
    cap.release()
    if not ok:
        print(json.dumps({"error": "No se pudo leer un frame del video."}))
        sys.exit(1)

    line_a, line_b = parse_coords(args.line, width, height)
    cv2.line(frame, (int(line_a[0]), int(line_a[1])), (int(line_b[0]), int(line_b[1])), (255, 80, 0), 2)

    if args.zone:
        zx1, zy1, zx2, zy2 = (int(v) for v in parse_zone(args.zone, width, height))
        cv2.rectangle(frame, (zx1, zy1), (zx2, zy2), (0, 220, 220), 2)

    image = encode_jpeg_data_uri(frame)

    print(json.dumps({"width": width, "height": height, "image": image}))


if __name__ == "__main__":
    main()
