import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="hud-border bg-black/40 p-8 flex flex-col items-center gap-4 text-center">
          <AlertTriangle size={32} className="text-crimson/60" />
          <h3 className="text-sm font-mono text-crimson/70 tracking-widest">
            {this.props.fallbackLabel || "ERRO NESTE MÓDULO"}
          </h3>
          <p className="text-[10px] font-mono text-crimson/40 max-w-md">
            {this.state.error?.message || "Erro desconhecido"}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="hud-button text-xs px-4 py-1"
          >
            TENTAR NOVAMENTE
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
