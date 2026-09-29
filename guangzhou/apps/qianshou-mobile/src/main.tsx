import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('qianshou-mobile: #root is missing')
createRoot(root).render(<App />)
