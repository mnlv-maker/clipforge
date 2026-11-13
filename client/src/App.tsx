import { Clapperboard, FilePlus2, FolderOpen, LayoutDashboard, Palette, Scissors, Settings as SettingsIcon } from "lucide-react";
import { NavLink, Route, Routes } from "react-router-dom";
import Create from "./pages/Create";
import Dashboard from "./pages/Dashboard";
import Placeholder from "./pages/Placeholder";
import ProjectDetail from "./pages/ProjectDetail";
import Editor from "./pages/Editor";
import Projects from "./pages/Projects";
import Settings from "./pages/Settings";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/crear", label: "Crear proyecto", icon: FilePlus2 },
  { to: "/proyectos", label: "Mis proyectos", icon: FolderOpen },
  { to: "/editor", label: "Editor", icon: Scissors },
  { to: "/plantillas", label: "Plantillas", icon: Palette },
  { to: "/configuracion", label: "Configuración", icon: SettingsIcon },
];

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Clapperboard size={17} /></span>
          ClipForge AI
        </div>
        <nav>
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="nav-link">
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/crear" element={<Create />} />
          <Route path="/proyectos" element={<Projects />} />
          <Route path="/proyectos/:id" element={<ProjectDetail />} />
          <Route path="/editor" element={<Editor />} />
          <Route path="/editor/:id" element={<ProjectDetail />} />
          <Route path="/plantillas" element={<Placeholder title="Plantillas" phase={8} description="Hoy eliges la plantilla dentro de cada proyecto. Aquí tendrás vistas previas y estilos propios." />} />
          <Route path="/configuracion" element={<Settings />} />
          <Route path="*" element={<Placeholder title="Página no encontrada" phase={1} description="Usa el menú lateral para volver a una sección." />} />
        </Routes>
      </main>
    </div>
  );
}
