import { useRef } from "react";

const CLOSE_DISTANCE = 56;

interface SheetHandleProps {
  onClose: () => void;
}

/** Drag handle of a phone bottom sheet; a downward swipe on it closes the sheet. */
export function SheetHandle({ onClose }: SheetHandleProps) {
  const startY = useRef<number | null>(null);
  return (
    <div
      className="sheet-handle"
      data-testid="sheet-handle"
      onPointerDown={(e) => {
        startY.current = e.clientY;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (startY.current !== null && e.clientY - startY.current > CLOSE_DISTANCE) {
          startY.current = null;
          onClose();
        }
      }}
      onPointerUp={() => {
        startY.current = null;
      }}
      onPointerCancel={() => {
        startY.current = null;
      }}
    >
      <span className="sheet-grip" aria-hidden="true" />
    </div>
  );
}
