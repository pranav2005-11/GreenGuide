import { useEffect, useState } from "react";
import axios from "axios";

function App() {
  const [users, setUsers] = useState([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    axios.get("http://localhost:5000/api/users")
      .then(res => setUsers(res.data))
      .catch(err => console.log(err));
  }, []);

  const addUser = () => {
    axios.post("http://localhost:5000/api/users", { name, email })
      .then(res => setUsers([...users, res.data]))
      .catch(err => console.log(err));
  };

  return (
    <div>
      <h1>Users List</h1>
      <input type="text" placeholder="Name" onChange={e => setName(e.target.value)} />
      <input type="text" placeholder="Email" onChange={e => setEmail(e.target.value)} />
      <button onClick={addUser}>Add User</button>
      <ul>
        {users.map(u => <li key={u._id}>{u.name} - {u.email}</li>)}
      </ul>
    </div>
  );
}

import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Home from './Home';
import Login from './Login';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
      </Routes>
    </Router>
  );
}



export default App;
