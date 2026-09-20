import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="card" role="alert">
      <p>页面暂时无法显示，请重试。</p>
      <button onClick={() => this.setState({ failed: false })}>重新加载页面内容</button>
    </div>;
    return this.props.children;
  }
}
