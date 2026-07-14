import { useEffect, useState } from 'react'
import Live from './Live'

export default function App() {
  const [route, setRoute] = useState('')

  useEffect(() => {
    window.ztools.onPluginEnter((action) => {
      setRoute(action.code)
    })
    window.ztools.onPluginOut(() => {
      setRoute('')
    })
  }, [])

  if (route === 'live') return <Live />

  return null
}
