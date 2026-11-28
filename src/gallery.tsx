import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { confirmAction } from "./confirm";
import { uploadImage } from "./model";

export function Gallery({ pictures, change, busy, setBusy, profileId }: {
  pictures: string[];
  change: (pictures: string[]) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  profileId: string;
}) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [fileHover, setFileHover] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const draggedPhoto = useRef<string | null>(null);
  const uploading = useRef(false);

  async function upload(files: File[]) {
    if (!files.length || busy || uploading.current) return;
    uploading.current = true;
    setBusy(true);
    setError("");
    const added: string[] = [];
    const failed: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setStatus(`Uploading photo ${index + 1} of ${files.length}`);
        try {
          added.push(await uploadImage(file, profileId));
        } catch {
          failed.push(file.name);
        }
      }
      const next = [...new Set([...pictures, ...added])];
      if (next.length !== pictures.length) change(next);
      if (failed.length) setError(`Could not upload ${failed.join(", ")}. Choose JPG, PNG or WebP files under 16 MB.`);
      const count = next.length - pictures.length;
      setStatus(count ? `${count} ${count === 1 ? "photo" : "photos"} added.` : "");
    } finally {
      uploading.current = false;
      setBusy(false);
    }
  }

  function move(from: number, to: number) {
    if (busy || from === to || from < 0 || to < 0 || to >= pictures.length) return;
    const next = pictures.slice();
    const [photo] = next.splice(from, 1);
    next.splice(to, 0, photo);
    change(next);
    setStatus(to === 0 ? "Cover photo changed." : `Photo moved to position ${to + 1}.`);
  }

  function endDrag() {
    draggedPhoto.current = null;
    setDropTarget(null);
  }

  return (
    <section className="fold">
      <h3>Product gallery</h3>
      <p className="muted">The first photo is the cover. Drag photos to reorder them or use the move buttons.</p>
      <label
        className={fileHover ? "upload active-drop" : "upload"}
        onDragOver={(event) => {
          if (busy || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setFileHover(true);
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFileHover(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setFileHover(false);
          void upload(Array.from(event.dataTransfer.files));
        }}
      >
        <ImagePlus size={22} aria-hidden />
        <strong>Drop photos here or choose files</strong>
        <small>JPG, PNG or WebP. Select multiple files at once.</small>
        <input
          type="file"
          aria-label="Choose gallery photos"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy}
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </label>
      {pictures.length > 0 && (
        <div className="media-grid">
          {pictures.map((photo, index) => (
            <div
              key={photo}
              className={dropTarget === photo ? "gallery-photo active-drop" : "gallery-photo"}
              draggable={!busy && pictures.length > 1}
              onDragStart={(event) => {
                if (busy || (event.target instanceof Element && event.target.closest("button"))) {
                  event.preventDefault();
                  return;
                }
                draggedPhoto.current = photo;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index + 1));
              }}
              onDragOver={(event) => {
                if (busy || !draggedPhoto.current || draggedPhoto.current === photo) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget(photo);
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedPhoto.current) move(pictures.indexOf(draggedPhoto.current), index);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              <img src={photo} draggable={false} alt={index === 0 ? "Cover photo" : `Product photo ${index + 1}`} />
              <small>{index === 0 ? "Cover" : `Photo ${index + 1}`}</small>
              {index > 0 && <button type="button" className="link" disabled={busy} onClick={async () => {
                if (await confirmAction("Make this the shared cover for sizes without their own photo?")) move(index, 0);
              }}>Set cover</button>}
              {pictures.length > 1 && (
                <div className="gallery-photo-actions">
                  <button type="button" className="link" disabled={busy || index === 0} aria-label={`Move photo ${index + 1} earlier`} onClick={() => move(index, index - 1)}>Earlier</button>
                  <button type="button" className="link" disabled={busy || index === pictures.length - 1} aria-label={`Move photo ${index + 1} later`} onClick={() => move(index, index + 1)}>Later</button>
                </div>
              )}
              <button type="button" className="link" disabled={busy} onClick={async () => {
                if (await confirmAction("Remove this photo from the product gallery? Save the product to apply.")) {
                  change(pictures.filter((picture) => picture !== photo));
                }
              }}>Remove photo</button>
            </div>
          ))}
        </div>
      )}
      <small role="status">{status}</small>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
