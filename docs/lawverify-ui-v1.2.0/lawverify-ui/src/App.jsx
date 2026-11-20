import React from 'react';
import { StoreProvider } from './store/AppStore.jsx';
import Dock from './components/Dock.jsx';
import Toast from './components/Toast.jsx';
import Drawer from './components/Drawer.jsx';
import UploadModal from './components/UploadModal.jsx';
import FormModal from './components/FormModal.jsx';
import HomePage from './pages/HomePage.jsx';
import ProcessingPage from './pages/ProcessingPage.jsx';
import WorkspacePage from './pages/workspace/WorkspacePage.jsx';
import CaseMemoryPage from './pages/CaseMemoryPage.jsx';
import ReportPage from './pages/ReportPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import { useApp, useToast } from './store/AppStore.jsx';

function Shell() {
  const { state, dispatch } = useApp();
  const toast = useToast();

  // 全局快捷键：Esc 关闭浮层；⌘/Ctrl+E 进报告
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('.wide-editor')) return;
      if (e.key === 'Escape') {
        if (state.upload.draft) {
          dispatch({ type: 'CLOSE_UPLOAD' });
          return;
        }
        dispatch({ type: 'CLOSE_DRAWER' });
        dispatch({ type: 'CLOSE_FORM' });
        dispatch({ type: 'CLOSE_UPLOAD' });
        dispatch({ type: 'ASSISTANT', open: false });
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        if (state.page === 'ws') dispatch({ type: 'NAV', page: 'report' });
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (state.page === 'ws' || state.page === 'memory' || state.page === 'report') {
          dispatch({ type: 'ASSISTANT', open: !state.assistantOpen, tool: 'auto' });
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        if (state.page === 'ws') dispatch({ type: 'SET_EDIT_MODE', on: !state.editMode });
        return;
      }

    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.page, state.sel, state.upload.draft, state.editMode, state.assistantOpen, dispatch]);

  return (
    <>

      {state.page === 'home' && <HomePage />}
      {state.page === 'proc' && <ProcessingPage />}
      {['ws', 'report', 'memory'].includes(state.page) && <WorkspacePage toast={toast} hidden={state.page !== 'ws'} />}
      {state.page === 'memory' && <CaseMemoryPage key={state.caseId} />}
      {state.page === 'report' && <ReportPage toast={toast} />}
      {state.page === 'account' && <AccountPage toast={toast} />}
      <Dock />
      <UploadModal toast={toast} />
      <FormModal toast={toast} />
      <Drawer />
      <Toast />
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
