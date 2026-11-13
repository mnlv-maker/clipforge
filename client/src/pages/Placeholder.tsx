interface Props {
  title: string;
  phase: number;
  description: string;
}

export default function Placeholder({ title, phase, description }: Props) {
  return (
    <section>
      <h1>{title}</h1>
      <div className="empty">
        <p className="empty-title">Esta sección estará lista en la Fase {phase}</p>
        <p className="muted">{description}</p>
      </div>
    </section>
  );
}
