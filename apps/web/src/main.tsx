import { createRoot } from 'react-dom/client'
import App from './App'
import './design/tokens.css'
import './dock/dock.css'

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
