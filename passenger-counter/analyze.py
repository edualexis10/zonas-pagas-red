#!/usr/bin/env python3
"""
Cuenta pasajeros que suben/bajan en un video de una puerta de bus, usando
detección y seguimiento de personas (YOLOv8) más el cruce de una línea virtual.

Puerta "principal": además evalúa si cada persona permaneció el tiempo
suficiente dentro de la zona del validador (--zone) para considerarla "paga".
Quien la cruza sin haber tenido "dwell" (permanencia) en esa zona se cuenta
como evasor.

Puerta "bajada": no hay validador. Cualquier persona que cruza la línea en
sentido de SUBIDA se cuenta como evasora (se asume que no es zona paga);
quien cruza en sentido de BAJADA solo se registra como información
("baja"), no afecta el conteo de evasión.

NOTA IMPORTANTE: no existe una señal directa de "pago" en el video; el
validador no se puede leer desde la imagen salvo que se entrene un modelo
específico para su luz/pantalla. Este script usa una heurística de
permanencia (dwell) frente al validador como proxy razonable, pero debe
calibrarse con video real y, si es posible, contrastarse contra el log de
transacciones del validador para medir su precisión.

Salida: un único JSON por stdout con el resumen y los eventos detectados.
"""
import argparse
import json
import sys

import cv2
from ultralytics import YOLO

PERSON_CLASS_ID = 0


def side_of_line(point, a, b):
    px, py = point
    ax, ay = a
    bx, by = b
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True, help="Ruta al video a analizar")
    parser.add_argument(
        "--door-type", required=True, choices=["principal", "bajada"],
        help="Tipo de puerta: 'principal' (con validador) o 'bajada' (sin validador)",
    )
    parser.add_argument("--model", default="yolov8n.pt", help="Pesos de YOLO a usar")
    parser.add_argument(
        "--line", default="0,0.5,1,0.5",
        help="Línea virtual de conteo 'x1,y1,x2,y2' normalizada (0-1) respecto al frame",
    )
    parser.add_argument(
        "--boarding-side", choices=["1", "2"], default="1",
        help=(
            "Lado de la línea (1 o 2, según el signo del producto cruzado) donde "
            "está la calle/vereda: cruzar de ese lado hacia el otro = SUBIDA. "
            "Solo aplica a puertas de bajada."
        ),
    )
    parser.add_argument(
        "--zone", default=None,
        help=(
            "Zona del validador 'x1,y1,x2,y2' normalizada (0-1). Requerida para "
            "puerta 'principal'."
        ),
    )
    parser.add_argument(
        "--dwell-frames", type=int, default=5,
        help="Frames mínimos dentro de la zona del validador para contar como 'pagó'",
    )
    parser.add_argument(
        "--hysteresis-frames", type=int, default=3,
        help="Frames consecutivos requeridos en el nuevo lado antes de confirmar un cruce",
    )
    parser.add_argument("--conf", type=float, default=0.4, help="Umbral de confianza de YOLO")
    args = parser.parse_args()

    if args.door_type == "principal" and not args.zone:
        print(
            json.dumps({"error": "Puerta 'principal' requiere --zone (zona del validador)."}),
            file=sys.stdout,
        )
        sys.exit(1)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"error": f"No se pudo abrir el video: {args.video}"}))
        sys.exit(1)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    cap.release()

    line_a, line_b = parse_coords(args.line, width, height)
    zone = parse_zone(args.zone, width, height) if args.zone else None

    model = YOLO(args.model)
    results = model.track(
        source=args.video,
        classes=[PERSON_CLASS_ID],
        conf=args.conf,
        persist=True,
        stream=True,
        verbose=False,
        tracker="bytetrack.yaml",
    )

    track_state = {}
    events = []
    frame_idx = 0

    for r in results:
        frame_idx += 1
        if r.boxes is None or r.boxes.id is None:
            continue

        boxes = r.boxes.xyxy.cpu().numpy()
        ids = r.boxes.id.cpu().numpy().astype(int)

        for box, tid in zip(boxes, ids):
            x1, y1, x2, y2 = box
            cx, cy = (x1 + x2) / 2, y2  # centro inferior (pies), más estable para cruces

            state = track_state.setdefault(
                tid,
                {
                    "side": None,
                    "pending_side": None,
                    "pending_count": 0,
                    "zone_frames": 0,
                    "validated": False,
                    "counted": False,
                },
            )

            if zone is not None:
                zx1, zy1, zx2, zy2 = zone
                if zx1 <= cx <= zx2 and zy1 <= cy <= zy2:
                    state["zone_frames"] += 1
                    if state["zone_frames"] >= args.dwell_frames:
                        state["validated"] = True

            s = side_of_line((cx, cy), line_a, line_b)
            cur_side = "1" if s >= 0 else "2"

            if state["side"] is None:
                state["side"] = cur_side
                continue

            if cur_side == state["side"]:
                state["pending_side"] = None
                state["pending_count"] = 0
                continue

            # lado distinto al confirmado: aplicar histéresis para filtrar ruido
            if state["pending_side"] == cur_side:
                state["pending_count"] += 1
            else:
                state["pending_side"] = cur_side
                state["pending_count"] = 1

            if state["pending_count"] < args.hysteresis_frames:
                continue

            # cruce confirmado
            from_side = state["side"]
            state["side"] = cur_side
            state["pending_side"] = None
            state["pending_count"] = 0

            if state["counted"]:
                continue

            timestamp = round(frame_idx / fps, 2)

            if args.door_type == "principal":
                event_type = "paga" if state["validated"] else "evade"
            else:
                is_boarding = from_side == args.boarding_side
                event_type = "evade" if is_boarding else "baja"

            events.append(
                {
                    "track_id": int(tid),
                    "frame": frame_idx,
                    "timestamp_s": timestamp,
                    "type": event_type,
                    "direction": f"{from_side}_to_{cur_side}",
                }
            )
            state["counted"] = True

    summary = {"paga": 0, "evade": 0, "baja": 0}
    for e in events:
        summary[e["type"]] += 1

    print(
        json.dumps(
            {
                "door_type": args.door_type,
                "fps": fps,
                "width": width,
                "height": height,
                "frames_processed": frame_idx,
                "summary": summary,
                "events": events,
            }
        )
    )


if __name__ == "__main__":
    main()
